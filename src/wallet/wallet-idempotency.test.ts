import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { Money } from '../shared/money.ts';
import { IdempotencyConflictError, WalletRepository } from './wallet-repository.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('Defina DATABASE_URL antes de rodar este teste');
}

const db = new SQL(url);
const repo = new WalletRepository(db);

async function createWallet(balance: string): Promise<string> {
  const id = crypto.randomUUID();
  const cents = Money.fromDecimal(balance, 'BRL').cents.toString();
  await db`
    INSERT INTO wallet (id, player_id, currency, balance_cents)
    VALUES (${id}, ${crypto.randomUUID()}, 'BRL', ${cents}::bigint)
  `;
  return id;
}

function debitWith(walletId: string, externalId: string, value: string, payloadHash = 'hash-a') {
  return repo.debit({
    walletId,
    amount: Money.fromDecimal(value, 'BRL'),
    provider: 'provider-teste',
    externalTransactionId: externalId,
    idempotencyKey: `provider-teste:${externalId}`,
    payloadHash,
    roundId: 'round-teste',
    gameId: 'game-teste',
  });
}

describe('WalletRepository: idempotência do débito', () => {
  test('mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const walletId = await createWallet('100.00');
    const externalId = crypto.randomUUID();

    const results = await Promise.all(
      Array.from({ length: 50 }, () => debitWith(walletId, externalId, '25.00')),
    );

    expect(results.filter((r) => r.idempotentReplay).length).toBe(49);
    expect(results.filter((r) => !r.idempotentReplay).length).toBe(1);
    for (const r of results) {
      expect(r.balance.cents).toBe(7500n);
    }

    const [wallet] = await db`
      SELECT balance_cents::text AS balance_cents FROM wallet WHERE id = ${walletId}
    `;
    expect(wallet.balance_cents).toBe('7500');

    const [{ count }] = await db`
      SELECT count(*)::int AS count FROM wallet_ledger_entry WHERE wallet_id = ${walletId}
    `;
    expect(count).toBe(1);
  });

  test('mesma chave com payload diferente é conflito, não replay', async () => {
    const walletId = await createWallet('100.00');
    const externalId = crypto.randomUUID();

    await debitWith(walletId, externalId, '25.00', 'hash-a');

    const second = debitWith(walletId, externalId, '30.00', 'hash-b');
    await expect(second).rejects.toBeInstanceOf(IdempotencyConflictError);

    const [wallet] = await db`
      SELECT balance_cents::text AS balance_cents FROM wallet WHERE id = ${walletId}
    `;
    expect(wallet.balance_cents).toBe('7500');
  });
});
