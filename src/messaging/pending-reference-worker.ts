import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../shared/money.ts';
import { applyTransaction } from '../wagering/apply-transaction.ts';
import { WagerTransaction } from '../wagering/wager-transaction.ts';
import { Wallet } from '../wallet/wallet.ts';
import { backoffSeconds } from './outbox-publisher.ts';

type Row = Record<string, any>;

/** Limite de tentativas: com backoff 2s, 4s, 8s... são cerca de 8 minutos de espera pela referência. */
export const MAX_REFERENCE_ATTEMPTS = 8;

export type ReferenceWorkResult = {
  processed: number;
  rejected: number;
  waiting: number;
  failed: number;
};

type Outcome = 'processed' | 'rejected' | 'waiting' | 'skipped';

const TX_COLUMNS = `id::text AS id, provider_id, external_transaction_id, idempotency_key,
  payload_hash, wallet_id::text AS wallet_id, player_id::text AS player_id,
  round_id, game_id, kind, currency, amount_cents::text AS amount_cents,
  status, failure_code, reference_external_transaction_id,
  reference_transaction_id::text AS reference_transaction_id,
  created_at, processed_at, attempts`;

async function query(em: EntityManager, sql: string, params: unknown[]): Promise<Row[]> {
  return (await em.execute(sql, params)) as unknown as Row[];
}

function toTransaction(r: Row): WagerTransaction {
  return WagerTransaction.rehydrate({
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
}

export class PendingReferenceWorker {
  constructor(
    private readonly orm: MikroORM,
    private readonly maxAttempts = MAX_REFERENCE_ATTEMPTS,
    private readonly batchSize = 50,
  ) {}

  /** Um ciclo. Pode rodar em várias instâncias ao mesmo tempo: o lock da wallet serializa. */
  async runOnce(filter: { providerId?: string } = {}): Promise<ReferenceWorkResult> {
    const result: ReferenceWorkResult = { processed: 0, rejected: 0, waiting: 0, failed: 0 };
    const providerId = filter.providerId ?? null;
    const candidates = await query(
      this.orm.em.fork(),
      `SELECT id::text AS id, wallet_id::text AS wallet_id
       FROM wager_transaction
       WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
         AND (?::text IS NULL OR provider_id = ?)
       ORDER BY next_attempt_at
       LIMIT ?`,
      [providerId, providerId, this.batchSize],
    );
    for (const c of candidates) {
      try {
        const outcome = await this.orm.em
          .fork()
          .transactional((em) => this.processOne(em, c.id, c.wallet_id));
        if (outcome !== 'skipped') result[outcome]++;
      } catch {
        result.failed++; // erro transitório: continua pendente e será tentado no próximo ciclo
      }
    }
    return result;
  }

  private async processOne(em: EntityManager, txId: string, walletId: string): Promise<Outcome> {
    // Mesma ordem do use case: primeiro a wallet, depois a transação. Sem deadlock.
    const [w] = await query(
      em,
      `SELECT id::text AS id, player_id::text AS player_id, currency,
              balance_cents::text AS balance_cents, version, created_at, updated_at
       FROM wallet WHERE id = ?::uuid FOR UPDATE`,
      [walletId],
    );
    if (!w) return 'skipped';
    const wallet = Wallet.rehydrate({
      id: w.id,
      playerId: w.player_id,
      balance: Money.fromCents(BigInt(w.balance_cents), w.currency),
      version: Number(w.version),
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    });

    // Se outro worker já resolveu enquanto esperávamos o lock, não sobra nada a fazer.
    const [r] = await query(
      em,
      `SELECT ${TX_COLUMNS} FROM wager_transaction
       WHERE id = ?::uuid AND status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
       FOR UPDATE SKIP LOCKED`,
      [txId],
    );
    if (!r) return 'skipped';
    const tx = toTransaction(r);

    let reference: WagerTransaction | undefined;
    let alreadyReversed = false;
    const [ref] = await query(
      em,
      `SELECT ${TX_COLUMNS} FROM wager_transaction
       WHERE provider_id = ? AND external_transaction_id = ?`,
      [tx.providerId, tx.referenceExternalTransactionId],
    );
    if (ref) {
      reference = toTransaction(ref);
      const reversals = await query(
        em,
        `SELECT 1 AS found FROM wager_transaction
         WHERE reference_transaction_id = ?::uuid
           AND kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`,
        [ref.id],
      );
      alreadyReversed = reversals.length > 0;
    }

    const now = new Date();
    const outcome = applyTransaction({
      transaction: tx,
      wallet,
      reference,
      referenceAlreadyReversed: alreadyReversed,
      entryId: crypto.randomUUID(),
      now,
    });
    const attempts = Number(r.attempts) + 1;

    if (outcome.type === 'PENDING_REFERENCE') {
      if (attempts < this.maxAttempts) {
        await query(
          em,
          `UPDATE wager_transaction
           SET attempts = ?, next_attempt_at = now() + (? * interval '1 second')
           WHERE id = ?::uuid`,
          [attempts, backoffSeconds(attempts), tx.id],
        );
        return 'waiting';
      }
      // Limite esgotado: rejeição definitiva, auditável, com evento.
      tx.reject('REFERENCE_NOT_FOUND');
      await this.save(em, tx, wallet.balance, attempts);
      await this.enqueue(em, tx.id, 'WagerTransactionRejected', tx, now);
      return 'rejected';
    }

    if (outcome.type === 'REJECTED') {
      await this.save(em, tx, wallet.balance, attempts);
      await this.enqueue(em, tx.id, 'WagerTransactionRejected', tx, now);
      return 'rejected';
    }

    // PROCESSED: transação, ledger, saldo e eventos na mesma transação SQL.
    await this.save(em, tx, outcome.wallet.balance, attempts);
    if (outcome.entry) {
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
        [outcome.wallet.balance.cents.toString(), now.toISOString(), wallet.id],
      );
      await this.enqueue(em, wallet.id, 'WalletBalanceChanged', tx, now, {
        walletId: wallet.id,
        transactionId: tx.id,
        direction: e.direction,
        money: { amount: e.money.toDecimal(), currency: e.money.currency },
        balanceBefore: { amount: e.balanceBefore.toDecimal(), currency: e.balanceBefore.currency },
        balanceAfter: { amount: e.balanceAfter.toDecimal(), currency: e.balanceAfter.currency },
        walletVersion: outcome.wallet.version,
      });
    }
    await this.enqueue(em, tx.id, 'WagerTransactionProcessed', tx, now);
    return 'processed';
  }

  private async save(
    em: EntityManager,
    tx: WagerTransaction,
    balance: Money,
    attempts: number,
  ): Promise<void> {
    await query(
      em,
      `UPDATE wager_transaction
       SET status = ?, failure_code = ?, reference_transaction_id = ?::uuid,
           balance_after_cents = ?::bigint, processed_at = ?::timestamptz, attempts = ?
       WHERE id = ?::uuid`,
      [
        tx.status, tx.failureCode ?? null, tx.referenceTransactionId ?? null,
        balance.cents.toString(), tx.processedAt?.toISOString() ?? null, attempts, tx.id,
      ],
    );
  }

  private async enqueue(
    em: EntityManager,
    aggregateId: string,
    eventType: string,
    tx: WagerTransaction,
    at: Date,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const eventId = crypto.randomUUID();
    const envelope = {
      eventId,
      eventType,
      aggregateId,
      correlationId: tx.id,
      occurredAt: at.toISOString(),
      version: 1,
      data: data ?? {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        status: tx.status,
        failureCode: tx.failureCode ?? null,
        money: { amount: tx.money.toDecimal(), currency: tx.money.currency },
      },
    };
    await query(
      em,
      `INSERT INTO outbox_message (id, aggregate_id, event_type, payload, occurred_at)
       VALUES (?::uuid, ?::uuid, ?, ?::jsonb, ?::timestamptz)`,
      [eventId, aggregateId, eventType, JSON.stringify(envelope), at.toISOString()],
    );
  }
}