import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { Money } from '../shared/money.ts';
import { WalletError } from './wallet.ts';
import { WalletRepository } from './wallet-repository.ts';

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

function debit(walletId: string, value: string) {
  return repo.debit({
    walletId,
    amount: Money.fromDecimal(value, 'BRL'),
    provider: 'teste',
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    payloadHash: 'teste',
    roundId: 'round-teste',
    gameId: 'game-teste',
  });
}

describe('WalletRepository: débito concorrente', () => {
  test('20 débitos de 1.00 sobre saldo de 10.00: exatamente 10 passam', async () => {
    const walletId = await createWallet('10.00');
    const attempts = Array.from({ length: 20 }, () => debit(walletId, '1.00'));
    const results = await Promise.allSettled(attempts);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(fulfilled.length).toBe(10);
    expect(rejected.length).toBe(10);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(WalletError);
      expect((r.reason as WalletError).code).toBe('INSUFFICIENT_FUNDS');
    }

    const [wallet] = await db`
      SELECT balance_cents::text AS balance_cents, version
      FROM wallet WHERE id = ${walletId}
    `;
    expect(wallet.balance_cents).toBe('0');
    expect(wallet.version).toBe(11);

    const [{ count }] = await db`
      SELECT count(*)::int AS count FROM wallet_ledger_entry WHERE wallet_id = ${walletId}
    `;
    expect(count).toBe(10);
  });

  test('dois débitos de 10.00 sobre 10.00: só um passa', async () => {
    const walletId = await createWallet('10.00');
    const results = await Promise.allSettled([
      debit(walletId, '10.00'),
      debit(walletId, '10.00'),
    ]);
    const passed = results.filter((r) => r.status === 'fulfilled').length;
    expect(passed).toBe(1);
  });
});
