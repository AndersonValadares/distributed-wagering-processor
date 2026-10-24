import { afterAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../shared/money.ts';
import { SubmitTransactionUseCase, type SubmitInput } from '../wagering/submit-transaction.ts';
import { WagerTransactionKind as Kind } from '../wagering/wager-transaction.ts';
import { PendingReferenceWorker } from './pending-reference-worker.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Defina DATABASE_URL antes de rodar este teste');

const orm = await MikroORM.init({
  clientUrl: url,
  entities: [],
  discovery: { warnWhenNoEntities: false },
});
const useCase = new SubmitTransactionUseCase(orm);
const PROVIDER = `provider-ref-${crypto.randomUUID().slice(0, 8)}`;
const filter = { providerId: PROVIDER };
afterAll(async () => {
  await orm.close();
});

async function createWallet(cents = '10000') {
  const id = crypto.randomUUID();
  const playerId = crypto.randomUUID();
  await orm.em.execute(
    `INSERT INTO wallet (id, player_id, currency, balance_cents) VALUES (?::uuid, ?::uuid, 'BRL', ?::bigint)`,
    [id, playerId, cents],
  );
  return { id, playerId, initialCents: BigInt(cents) };
}
type W = Awaited<ReturnType<typeof createWallet>>;

function input(w: W, ext: string, kind: SubmitInput['kind'], ref?: string): SubmitInput {
  return {
    providerId: PROVIDER,
    externalTransactionId: ext,
    idempotencyKey: `${PROVIDER}:${ext}`,
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: Money.fromDecimal('25.00', 'BRL'),
    referenceExternalTransactionId: ref,
  };
}

async function one(sql: string, params: unknown[]) {
  const [row] = (await orm.em.execute(sql, params)) as unknown as Record<string, any>[];
  return row!;
}
const balance = async (w: W) =>
  (await one(`SELECT balance_cents::text AS v FROM wallet WHERE id = ?::uuid`, [w.id])).v;
const ledger = async (w: W) =>
  (await one(`SELECT count(*)::int AS v FROM wallet_ledger_entry WHERE wallet_id = ?::uuid`, [w.id])).v;
const statusOf = async (ext: string) =>
  one(`SELECT status, failure_code, attempts FROM wager_transaction WHERE provider_id = ? AND external_transaction_id = ?`, [PROVIDER, ext]);
const forceDue = (ext: string) =>
  orm.em.execute(
    `UPDATE wager_transaction SET next_attempt_at = now() WHERE provider_id = ? AND external_transaction_id = ?`,
    [PROVIDER, ext],
  );

/** Invariante final: saldo == saldo inicial + créditos - débitos do ledger. */
async function assertLedgerMatches(w: W) {
  const row = await one(
    `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_cents ELSE -amount_cents END), 0)::text AS net
     FROM wallet_ledger_entry WHERE wallet_id = ?::uuid`,
    [w.id],
  );
  expect(BigInt(await balance(w))).toBe(w.initialCents + BigInt(row.net));
}

describe('PendingReferenceWorker', () => {
  test('REFUND chega antes da BET: depois que a BET chega, o worker aplica o REFUND', async () => {
    const w = await createWallet();
    const refund = await useCase.execute(input(w, 'refund-1', Kind.Refund, 'bet-1'));
    expect(refund.status).toBe('PENDING_REFERENCE');
    await useCase.execute(input(w, 'bet-1', Kind.Bet));
    expect(await balance(w)).toBe('7500');

    const r = await new PendingReferenceWorker(orm).runOnce(filter);
    expect(r.processed).toBe(1);
    expect((await statusOf('refund-1')).status).toBe('PROCESSED');
    expect(await balance(w)).toBe('10000');
    expect(await ledger(w)).toBe(2);
    await assertLedgerMatches(w);
  });

  test('ROLLBACK de uma WIN que chega depois: o worker debita (inverso da referência)', async () => {
    const w = await createWallet();
    await useCase.execute(input(w, 'rb-1', Kind.Rollback, 'win-1'));
    await useCase.execute(input(w, 'win-1', Kind.Win));
    expect(await balance(w)).toBe('12500');

    await new PendingReferenceWorker(orm).runOnce(filter);
    expect((await statusOf('rb-1')).status).toBe('PROCESSED');
    expect(await balance(w)).toBe('10000');
    await assertLedgerMatches(w);
  });

  test('referência nunca chega: espera com backoff e depois REJECTED com REFERENCE_NOT_FOUND', async () => {
    const w = await createWallet();
    await useCase.execute(input(w, 'refund-2', Kind.Refund, 'bet-fantasma'));
    const worker = new PendingReferenceWorker(orm, 2); // limite de 2 tentativas no teste

    const first = await worker.runOnce(filter);
    expect(first.waiting).toBe(1);
    expect((await statusOf('refund-2')).attempts).toBe(1);

    const notDue = await worker.runOnce(filter); // ainda dentro do backoff
    expect(notDue.waiting + notDue.rejected + notDue.processed).toBe(0);

    await forceDue('refund-2');
    const last = await worker.runOnce(filter);
    expect(last.rejected).toBe(1);
    const tx = await statusOf('refund-2');
    expect(tx.status).toBe('REJECTED');
    expect(tx.failure_code).toBe('REFERENCE_NOT_FOUND');

    const events = await one(
      `SELECT count(*)::int AS v FROM outbox_message o
       JOIN wager_transaction t ON t.id = o.aggregate_id
       WHERE t.provider_id = ? AND t.external_transaction_id = 'refund-2'
         AND o.event_type = 'WagerTransactionRejected'`,
      [PROVIDER],
    );
    expect(events.v).toBe(1);
    expect(await balance(w)).toBe('10000');
    expect(await ledger(w)).toBe(0);
  });

  test('dois workers ao mesmo tempo: o REFUND é aplicado uma única vez', async () => {
    const w = await createWallet();
    await useCase.execute(input(w, 'refund-3', Kind.Refund, 'bet-3'));
    await useCase.execute(input(w, 'bet-3', Kind.Bet));

    const a = new PendingReferenceWorker(orm);
    const b = new PendingReferenceWorker(orm);
    const rounds = await Promise.all([a.runOnce(filter), b.runOnce(filter), a.runOnce(filter)]);
    expect(rounds.reduce((s, r) => s + r.processed, 0)).toBe(1);
    expect(await balance(w)).toBe('10000');
    expect(await ledger(w)).toBe(2); // débito da BET + um único crédito do REFUND
    await assertLedgerMatches(w);
  });
});