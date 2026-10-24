import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../shared/money.ts';
import { computePayloadHash } from '../wagering/payload-hash.ts';
import { LedgerDirection, WagerTransactionKind } from '../wagering/wager-transaction.ts';
import { WalletLedgerEntry } from '../wagering/wallet-ledger-entry.ts';
import { Wallet } from './wallet.ts';

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor(playerId: string, currency: string) {
    super(`já existe wallet ${currency} para o player ${playerId}`);
    this.name = 'WalletAlreadyExistsError';
  }
}

export type CreateWalletInput = { playerId: string; initialBalance: Money };

export type CreateWalletResult = {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
};

@Injectable()
export class CreateWalletUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    const now = new Date();
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      at: now,
    });
    const balance = wallet.balance;

    // Wallet, transação OPENING e ledger: tudo numa transação SQL, ou nada.
    await this.orm.em.fork().transactional(async (em) => {
      // O UNIQUE (player_id, currency) do banco é quem garante "uma wallet por player e moeda".
      const inserted = (await em.execute(
        `INSERT INTO wallet (id, player_id, currency, balance_cents, version, created_at, updated_at)
         VALUES (?::uuid, ?::uuid, ?, ?::bigint, 1, ?::timestamptz, ?::timestamptz)
         ON CONFLICT (player_id, currency) DO NOTHING
         RETURNING id::text AS id`,
        [
          wallet.id, wallet.playerId, balance.currency, balance.cents.toString(),
          now.toISOString(), now.toISOString(),
        ],
      )) as unknown as unknown[];
      if (inserted.length === 0) {
        throw new WalletAlreadyExistsError(wallet.playerId, balance.currency);
      }

      // Saldo inicial zero: não há movimentação, então não há OPENING nem lançamento.
      if (balance.isZero()) return;

      const transactionId = crypto.randomUUID();
      const externalId = `opening:${wallet.id}`;
      const payloadHash = computePayloadHash({
        providerId: 'internal',
        externalTransactionId: externalId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'opening',
        gameId: 'opening',
        kind: WagerTransactionKind.Opening,
        money: balance,
        referenceExternalTransactionId: undefined,
      });
      await em.execute(
        `INSERT INTO wager_transaction (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, currency, amount_cents,
           status, balance_after_cents, created_at, processed_at
         ) VALUES (?::uuid, 'internal', ?, ?, ?, ?::uuid, ?::uuid, 'opening', 'opening',
                   'OPENING', ?, ?::bigint, 'PROCESSED', ?::bigint, ?::timestamptz, ?::timestamptz)`,
        [
          transactionId, externalId, externalId, payloadHash, wallet.id, wallet.playerId,
          balance.currency, balance.cents.toString(), balance.cents.toString(),
          now.toISOString(), now.toISOString(),
        ],
      );

      // create() confere a aritmética: 0 + saldo inicial = saldo inicial.
      const entry = WalletLedgerEntry.create({
        id: crypto.randomUUID(),
        walletId: wallet.id,
        transactionId,
        direction: LedgerDirection.Credit,
        money: balance,
        balanceBefore: Money.fromCents(0n, balance.currency),
        balanceAfter: balance,
        createdAt: now,
      });
      await em.execute(
        `INSERT INTO wallet_ledger_entry (
           id, wallet_id, transaction_id, direction, amount_cents,
           balance_before_cents, balance_after_cents, created_at
         ) VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?::bigint, ?::bigint, ?::bigint, ?::timestamptz)`,
        [
          entry.id, entry.walletId, entry.transactionId, entry.direction,
          entry.money.cents.toString(), entry.balanceBefore.cents.toString(),
          entry.balanceAfter.cents.toString(), entry.createdAt.toISOString(),
        ],
      );
    });

    return { id: wallet.id, playerId: wallet.playerId, balance, version: wallet.version };
  }
}