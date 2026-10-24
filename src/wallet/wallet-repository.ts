import { SQL } from 'bun';
import { Money } from '../shared/money.ts';
import { Wallet } from './wallet.ts';

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export type DebitInput = {
  walletId: string;
  amount: Money;
  provider: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  roundId: string;
  gameId: string;
};

export type DebitResult = {
  balance: Money;
  idempotentReplay: boolean;
};

export class WalletRepository {
  constructor(private readonly db: SQL) {}

  /**
   * Débito atômico e idempotente.
   * O FOR UPDATE serializa todas as operações da mesma wallet, então a checagem
   * de duplicidade feita logo após o lock não sofre race entre instâncias.
   */
  async debit(input: DebitInput): Promise<DebitResult> {
    return this.db.begin(async (tx) => {
      const [row] = await tx`
        SELECT player_id::text AS player_id, currency, balance_cents::text AS balance_cents
        FROM wallet
        WHERE id = ${input.walletId}
        FOR UPDATE
      `;
      if (!row) {
        throw new Error('carteira não encontrada');
      }

      // Replay: a mesma transação externa já foi processada?
      const [existing] = await tx`
        SELECT wallet_id::text AS wallet_id,
               payload_hash,
               balance_after_cents::text AS balance_after_cents
        FROM wager_transaction
        WHERE provider_id = ${input.provider}
          AND external_transaction_id = ${input.externalTransactionId}
      `;
      if (existing) {
        if (existing.wallet_id !== input.walletId || existing.payload_hash !== input.payloadHash) {
          throw new IdempotencyConflictError(
            'mesma chave de idempotência com payload ou carteira diferente',
          );
        }
        return {
          balance: Money.fromCents(BigInt(existing.balance_after_cents), input.amount.currency),
          idempotentReplay: true,
        };
      }

      const current = Money.fromCents(BigInt(row.balance_cents), row.currency);
      // Lança INSUFFICIENT_FUNDS ou CURRENCY_MISMATCH; o throw faz ROLLBACK de tudo.
            
            const transactionId = crypto.randomUUID();
      const now = new Date();
      const newBalance = Wallet.rehydrate({
        id: input.walletId,
        playerId: row.player_id,
        balance: current,
        version: 1, // provisório: o use case novo vai ler a version real do banco
        createdAt: now,
        updatedAt: now,
      }).debit({
        amount: input.amount,
        transactionId,
        entryId: crypto.randomUUID(),
        at: now,
      }).wallet.balance;
      

      await tx`
        INSERT INTO wager_transaction (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, currency, amount_cents,
          status, balance_after_cents
        ) VALUES (
          ${transactionId}, ${input.provider}, ${input.externalTransactionId},
          ${input.idempotencyKey}, ${input.payloadHash},
          ${input.walletId}, ${row.player_id}, ${input.roundId}, ${input.gameId},
          'BET', ${input.amount.currency}, ${input.amount.cents.toString()}::bigint,
          'PROCESSED', ${newBalance.cents.toString()}::bigint
        )
      `;

           await tx`
        INSERT INTO wallet_ledger_entry (
          id, wallet_id, transaction_id, direction, amount_cents,
          balance_before_cents, balance_after_cents
        ) VALUES (
          ${crypto.randomUUID()}, ${input.walletId}, ${transactionId}, 'DEBIT',
          ${input.amount.cents.toString()}::bigint,
          ${current.cents.toString()}::bigint,
          ${newBalance.cents.toString()}::bigint
        )
      `;

      await tx`
        UPDATE wallet
        SET balance_cents = ${newBalance.cents.toString()}::bigint,
            version = version + 1,
            updated_at = now()
        WHERE id = ${input.walletId}
      `;

      return { balance: newBalance, idempotentReplay: false };
    });
  }
}
