import { afterAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../shared/money.ts';
import {
  IdempotencyConflictError,
  SubmitTransactionUseCase,
  type SubmitInput,
} from './submit-transaction.ts';
import { WagerTransactionKind as Kind } from './wager-transaction.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Defina DATABASE_URL antes de rodar este teste');

const orm = await MikroORM.init({
  clientUrl: url,
  entities: [],
  discovery: { warnWhenNoEntities: false },
});
const useCase = new SubmitTransactionUseCase(orm);
afterAll(async () => { await orm.close(); });

async function createWallet(balance: string) {
  const id = crypto.randomUUID();
  const playerId = crypto.randomUUID();
  const cents = Money.fromDecimal(balance, 'BRL').cents.toString();
  await orm.em.execute(
    `INSERT INTO wallet (id, player_id, currency, balance_cents) VALUES (?::uuid, ?::uuid, 'BRL', ?::bigint)`,
    [id, playerId, cents],
  );
  return { id, playerId, initialCents: BigInt(cents) };
}

type W = Awaited<ReturnType<typeof createWallet>>;

function input(w: W, ext: string, amount: string, over: Partial<SubmitInput> = {}): SubmitInput {
  return {
    providerId: 'provider-teste',
    externalTransactionId: ext,
    idempotencyKey: `provider-teste:${ext}`,
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: Money.fromDecimal(amount, 'BRL'),
    referenceExternalTransactionId: undefined,
    ...over,
  };
}

/** Invariante final: saldo da wallet == saldo inicial + créditos - débitos do ledger. */
async function assertLedgerMatchesBalance(w: W) {
  const [row] = (await orm.em.execute(
    `SELECT (SELECT balance_cents::text FROM wallet WHERE id = ?::uuid) AS balance,
            (SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_cents ELSE -amount_cents END), 0)::text
             FROM wallet_ledger_entry WHERE wallet_id = ?::uuid) AS net`,
    [w.id, w.id],
  )) as unknown as { balance: string; net: string }[];
  expect(BigInt(row!.balance)).toBe(w.initialCents + BigInt(row!.net));
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const [row] = (await orm.em.execute(sql, params)) as unknown as { n: number }[];
  return row!.n;
}

describe('SubmitTransaction: cenário obrigatório', () => {
  test('saldo 100.00, duas apostas de 80.00 ao mesmo tempo: uma passa, outra é REJECTED', async () => {
    const w = await createWallet('100.00');
    const [a, b] = await Promise.all([
      useCase.execute(input(w, 'bet-a', '80.00')),
      useCase.execute(input(w, 'bet-b', '80.00')),
    ]);

    expect([a.status, b.status].sort()).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = a.status === 'REJECTED' ? a : b;
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(a.balance.toDecimal()).toBe('20.00');

    expect(await count(`SELECT count(*)::int AS n FROM wallet_ledger_entry WHERE wallet_id = ?::uuid AND direction = 'DEBIT'`, [w.id])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM outbox_message WHERE aggregate_id = ?::uuid AND event_type = 'WagerTransactionRejected'`, [rejected.transactionId])).toBe(1);
    await assertLedgerMatchesBalance(w);
  });

  test('reenviar a aposta REJECTED devolve o mesmo resultado (replay), sem processar de novo', async () => {
    const w = await createWallet('100.00');
    const first = await useCase.execute(input(w, 'bet-x', '150.00'));
    expect(first.status).toBe('REJECTED');
    await orm.em.execute(`UPDATE wallet SET balance_cents = 100000 WHERE id = ?::uuid`, [w.id]);

    const second = await useCase.execute(input(w, 'bet-x', '150.00'));
    expect(second.idempotentReplay).toBe(true);
    expect(second.status).toBe('REJECTED');
    expect(second.transactionId).toBe(first.transactionId);
  });
});

describe('SubmitTransaction: idempotência', () => {
  test('mesma aposta 50 vezes em paralelo: um único débito', async () => {
    const w = await createWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 50 }, () => useCase.execute(input(w, 'bet-50', '25.00'))),
    );
    expect(results.filter((r) => !r.idempotentReplay).length).toBe(1);
    expect(results.filter((r) => r.idempotentReplay).length).toBe(49);
    for (const r of results) expect(r.balance.toDecimal()).toBe('75.00');
    expect(await count(`SELECT count(*)::int AS n FROM wallet_ledger_entry WHERE wallet_id = ?::uuid`, [w.id])).toBe(1);
    await assertLedgerMatchesBalance(w);
  });

  test('mesma chave com payload diferente é conflito, não replay', async () => {
    const w = await createWallet('100.00');
    await useCase.execute(input(w, 'bet-c', '25.00'));
    await expect(useCase.execute(input(w, 'bet-c', '30.00'))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await assertLedgerMatchesBalance(w);
  });
});

describe('SubmitTransaction: referências', () => {
  test('REFUND antes da BET fica PENDING_REFERENCE e não mexe no saldo', async () => {
    const w = await createWallet('100.00');
    const r = await useCase.execute(
      input(w, 'refund-1', '25.00', {
        kind: Kind.Refund,
        referenceExternalTransactionId: 'bet-ainda-nao-chegou',
      }),
    );
    expect(r.status).toBe('PENDING_REFERENCE');
    expect(r.balance.toDecimal()).toBe('100.00');
    expect(await count(`SELECT count(*)::int AS n FROM wallet_ledger_entry WHERE wallet_id = ?::uuid`, [w.id])).toBe(0);
    await assertLedgerMatchesBalance(w);
  });

  test('BET, depois REFUND: devolve o valor, e um segundo REFUND é rejeitado', async () => {
    const w = await createWallet('100.00');
    await useCase.execute(input(w, 'bet-r', '25.00'));
    const refund = (ext: string) =>
      useCase.execute(
        input(w, ext, '25.00', { kind: Kind.Refund, referenceExternalTransactionId: 'bet-r' }),
      );
    const first = await refund('refund-a');
    expect(first.status).toBe('PROCESSED');
    expect(first.balance.toDecimal()).toBe('100.00');
    const second = await refund('refund-b');
    expect(second.status).toBe('REJECTED');
    expect(second.failureCode).toBe('ALREADY_REVERSED');
    await assertLedgerMatchesBalance(w);
  });
});
