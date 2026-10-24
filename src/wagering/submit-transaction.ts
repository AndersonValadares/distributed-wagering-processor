import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../shared/money.ts';
import { Wallet } from '../wallet/wallet.ts';
import { applyTransaction } from './apply-transaction.ts';
import type { FailureCode } from './failure-code.ts';
import { computePayloadHash } from './payload-hash.ts';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from './wager-transaction.ts';

type Row = Record<string, any>;

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class WalletNotFoundError extends Error {
  readonly code = 'WALLET_NOT_FOUND';
  constructor(walletId: string) {
    super(`wallet não encontrada: ${walletId}`);
    this.name = 'WalletNotFoundError';
  }
}

export type SubmitInput = {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
};

export type SubmitResult = {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode: FailureCode | undefined;
  balance: Money;
  idempotentReplay: boolean;
};

async function query(em: EntityManager, sql: string, params: unknown[]): Promise<Row[]> {
  return (await em.execute(sql, params)) as unknown as Row[];
}

export class SubmitTransactionUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(input: SubmitInput): Promise<SubmitResult> {
    const payloadHash = computePayloadHash(input);
    // Valida a entrada ANTES de tocar no banco (OPENING, referência ausente, valor zero...).
    const tx = WagerTransaction.create({
      id: crypto.randomUUID(),
      ...input,
      payloadHash,
      createdAt: new Date(),
    });
    // Tudo abaixo roda numa única transação SQL. Se lançar erro, volta tudo (ROLLBACK).
    return this.orm.em.fork().transactional((em) => this.run(em, tx));
  }

  private async run(em: EntityManager, tx: WagerTransaction): Promise<SubmitResult> {
    // 1) Trava a wallet. Quem chegar depois espera aqui. Wallets diferentes não se bloqueiam.
    const [w] = await query(
      em,
      `SELECT id::text AS id, player_id::text AS player_id, currency,
              balance_cents::text AS balance_cents, version, created_at, updated_at
       FROM wallet WHERE id = ?::uuid FOR UPDATE`,
      [tx.walletId],
    );
    if (!w) throw new WalletNotFoundError(tx.walletId);
    const wallet = Wallet.rehydrate({
      id: w.id,
      playerId: w.player_id,
      balance: Money.fromCents(BigInt(w.balance_cents), w.currency),
      version: Number(w.version),
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    });

    // 2) Idempotência: insere já como PENDING. Se a chave já existe, não insere nada.
    const inserted = await query(
      em,
      `INSERT INTO wager_transaction (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, currency, amount_cents,
         status, reference_external_transaction_id, created_at
       ) VALUES (?::uuid, ?, ?, ?, ?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?::bigint,
                 'PENDING', ?, ?::timestamptz)
       ON CONFLICT DO NOTHING
       RETURNING id::text AS id`,
      [
        tx.id, tx.providerId, tx.externalTransactionId, tx.idempotencyKey, tx.payloadHash,
        tx.walletId, tx.playerId, tx.roundId, tx.gameId, tx.kind, tx.money.currency,
        tx.money.cents.toString(), tx.referenceExternalTransactionId ?? null,
        tx.createdAt.toISOString(),
      ],
    );
    if (inserted.length === 0) return this.replay(em, tx, wallet);

    // 3) Busca a referência (só REFUND/ROLLBACK) e vê se ela já foi revertida.
    let reference: WagerTransaction | undefined;
    let alreadyReversed = false;
    if (tx.requiresReference()) {
      const [r] = await query(
        em,
        `SELECT id::text AS id, provider_id, external_transaction_id, idempotency_key,
                payload_hash, wallet_id::text AS wallet_id, player_id::text AS player_id,
                round_id, game_id, kind, currency, amount_cents::text AS amount_cents,
                status, failure_code, reference_external_transaction_id,
                reference_transaction_id::text AS reference_transaction_id,
                created_at, processed_at
         FROM wager_transaction WHERE provider_id = ? AND external_transaction_id = ?`,
        [tx.providerId, tx.referenceExternalTransactionId],
      );
      if (r) {
        reference = WagerTransaction.rehydrate({
          id: r.id,
          providerId: r.provider_id,
          externalTransactionId: r.external_transaction_id,
          idempotencyKey: r.idempotency_key,
          payloadHash: r.payload_hash,
          walletId: r.wallet_id,
          playerId: r.player_id,
          roundId: r.round_id,
          gameId: r.game_id,
          kind: r.kind,
          money: Money.fromCents(BigInt(r.amount_cents), r.currency),
          referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
          status: r.status,
          referenceTransactionId: r.reference_transaction_id ?? undefined,
          failureCode: r.failure_code ?? undefined,
          processedAt: r.processed_at ?? undefined,
          createdAt: r.created_at,
        });
        const reversals = await query(
          em,
          `SELECT 1 AS found FROM wager_transaction
           WHERE reference_transaction_id = ?::uuid
             AND kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`,
          [r.id],
        );
        alreadyReversed = reversals.length > 0;
      }
    }

    // 4) Decide (função pura, já testada).
    const now = new Date();
    const outcome = applyTransaction({
      transaction: tx,
      wallet,
      reference,
      referenceAlreadyReversed: alreadyReversed,
      entryId: crypto.randomUUID(),
      now,
    });
    const finalWallet = outcome.type === 'PROCESSED' ? outcome.wallet : wallet;

    // 5) Grava o resultado. REJECTED também é gravado, e é commit, não exceção.
    await query(
      em,
      `UPDATE wager_transaction
       SET status = ?, failure_code = ?, reference_transaction_id = ?::uuid,
           balance_after_cents = ?::bigint, processed_at = ?::timestamptz
       WHERE id = ?::uuid`,
      [
        tx.status, tx.failureCode ?? null, tx.referenceTransactionId ?? null,
        finalWallet.balance.cents.toString(), tx.processedAt?.toISOString() ?? null, tx.id,
      ],
    );

    if (outcome.type === 'PROCESSED' && outcome.entry) {
      const e = outcome.entry;
      await query(
        em,
        `INSERT INTO wallet_ledger_entry (
           id, wallet_id, transaction_id, direction, amount_cents,
           balance_before_cents, balance_after_cents, created_at
         ) VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?::bigint, ?::bigint, ?::bigint, ?::timestamptz)`,
        [
          e.id, e.walletId, e.transactionId, e.direction, e.money.cents.toString(),
          e.balanceBefore.cents.toString(), e.balanceAfter.cents.toString(),
          e.createdAt.toISOString(),
        ],
      );
      await query(
        em,
        `UPDATE wallet SET balance_cents = ?::bigint, version = version + 1,
                updated_at = ?::timestamptz WHERE id = ?::uuid`,
        [finalWallet.balance.cents.toString(), now.toISOString(), wallet.id],
      );
      await this.enqueue(em, wallet.id, 'WalletBalanceChanged', tx, now, {
        walletId: wallet.id,
        transactionId: tx.id,
        direction: e.direction,
        money: { amount: e.money.toDecimal(), currency: e.money.currency },
        balanceBefore: { amount: e.balanceBefore.toDecimal(), currency: e.balanceBefore.currency },
        balanceAfter: { amount: e.balanceAfter.toDecimal(), currency: e.balanceAfter.currency },
        walletVersion: finalWallet.version,
      });
    }

    // 6) Evento da transação, na mesma transação SQL (outbox).
    const eventType =
      outcome.type === 'PROCESSED'
        ? 'WagerTransactionProcessed'
        : outcome.type === 'REJECTED'
          ? 'WagerTransactionRejected'
          : 'WagerTransactionPendingReference';
    await this.enqueue(em, tx.id, eventType, tx, now, {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId,
      kind: tx.kind,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      money: { amount: tx.money.toDecimal(), currency: tx.money.currency },
    });

    return {
      transactionId: tx.id,
      status: tx.status,
      failureCode: tx.failureCode,
      balance: finalWallet.balance,
      idempotentReplay: false,
    };
  }

  /** A chave já existia: igual = replay (devolve o resultado original), diferente = conflito. */
  private async replay(em: EntityManager, tx: WagerTransaction, wallet: Wallet): Promise<SubmitResult> {
    const rows = await query(
      em,
      `SELECT id::text AS id, payload_hash, status, failure_code,
              balance_after_cents::text AS balance_after_cents
       FROM wager_transaction
       WHERE provider_id = ? AND (idempotency_key = ? OR external_transaction_id = ?)`,
      [tx.providerId, tx.idempotencyKey, tx.externalTransactionId],
    );
    if (rows.some((r) => !tx.matchesPayload(r.payload_hash))) {
      throw new IdempotencyConflictError('mesma chave de idempotência com payload diferente');
    }
    const [original] = rows;
    if (!original) throw new Error('conflito de unicidade sem linha existente');
    const cents = BigInt(original.balance_after_cents ?? wallet.balance.cents.toString());
    return {
      transactionId: original.id,
      status: original.status,
      failureCode: original.failure_code ?? undefined,
      balance: Money.fromCents(cents, wallet.currency),
      idempotentReplay: true,
    };
  }

  private async enqueue(
    em: EntityManager,
    aggregateId: string,
    eventType: string,
    tx: WagerTransaction,
    at: Date,
    data: Record<string, unknown>,
  ): Promise<void> {
    const eventId = crypto.randomUUID();
    const envelope = {
      eventId,
      eventType,
      aggregateId,
      correlationId: tx.id,
      occurredAt: at.toISOString(),
      version: 1,
      data,
    };
    await query(
      em,
      `INSERT INTO outbox_message (id, aggregate_id, event_type, payload, occurred_at)
       VALUES (?::uuid, ?::uuid, ?, ?::jsonb, ?::timestamptz)`,
      [eventId, aggregateId, eventType, JSON.stringify(envelope), at.toISOString()],
    );
  }
}