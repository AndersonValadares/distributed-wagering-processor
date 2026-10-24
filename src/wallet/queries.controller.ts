import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { ValidationError } from '../http/parsers.ts';
import { WalletNotFoundError } from '../wagering/submit-transaction.ts';
import { inc } from '../observability/metrics.ts';

type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(what: string) {
    super(`${what} não encontrado`);
    this.name = 'NotFoundError';
  }
}

function uuid(value: string, name: string): string {
  if (!UUID.test(value)) throw new ValidationError(`${name} deve ser um UUID`);
  return value;
}

/** Centavos -> "123.45". Usa bigint, nunca number. */
function dec(cents: string): string {
  const c = BigInt(cents);
  return `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;
}

const money = (cents: string, currency: string) => ({ amount: dec(cents), currency });

@Controller()
export class QueriesController {
  constructor(private readonly orm: MikroORM) {}

  private async rows(sql: string, params: unknown[]): Promise<Row[]> {
    return (await this.orm.em.fork().execute(sql, params)) as unknown as Row[];
  }

  @Get('wallets/:walletId')
  async wallet(@Param('walletId') walletId: string) {
    const [w] = await this.rows(
      `SELECT id::text AS id, player_id::text AS player_id, currency,
              balance_cents::text AS balance_cents, version
       FROM wallet WHERE id = ?::uuid`,
      [uuid(walletId, 'walletId')],
    );
    if (!w) throw new WalletNotFoundError(walletId);
    return {
      id: w.id,
      playerId: w.player_id,
      balance: money(w.balance_cents, w.currency),
      version: Number(w.version),
    };
  }

  /** Cursor opaco e estável: base64url de (created_at, id) do último item. */
  @Get('wallets/:walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    uuid(walletId, 'walletId');
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError('limit deve ser um inteiro entre 1 e 200');
    }
    let after: { at: string; id: string } | undefined;
    if (cursor) {
      try {
        after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (typeof after?.at !== 'string' || !UUID.test(after.id)) throw new Error();
      } catch {
        throw new ValidationError('cursor inválido');
      }
    }
    const [exists] = await this.rows(`SELECT 1 AS ok FROM wallet WHERE id = ?::uuid`, [walletId]);
    if (!exists) throw new WalletNotFoundError(walletId);

    const items = await this.rows(
      `SELECT id::text AS id, transaction_id::text AS transaction_id, direction,
              amount_cents::text AS amount_cents, balance_before_cents::text AS before_cents,
              balance_after_cents::text AS after_cents,
              (SELECT currency FROM wallet WHERE id = ?::uuid) AS currency,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM wallet_ledger_entry
       WHERE wallet_id = ?::uuid
         AND (?::text IS NULL OR (created_at, id) > (?::timestamptz, ?::uuid))
       ORDER BY created_at, id
       LIMIT ?`,
      [walletId, walletId, after?.at ?? null, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((e) => ({
        id: e.id,
        transactionId: e.transaction_id,
        direction: e.direction,
        money: money(e.amount_cents, e.currency),
        balanceBefore: money(e.before_cents, e.currency),
        balanceAfter: money(e.after_cents, e.currency),
        createdAt: e.created_at,
      })),
      nextCursor:
        items.length > limit && last
          ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString('base64url')
          : null,
    };
  }

  private txSelect = `SELECT id::text AS id, provider_id, external_transaction_id, wallet_id::text AS wallet_id,
      kind, status, failure_code, currency, amount_cents::text AS amount_cents,
      balance_after_cents::text AS balance_after_cents, reference_external_transaction_id
    FROM wager_transaction`;

  private txBody(t: Row) {
    return {
      transactionId: t.id,
      providerId: t.provider_id,
      externalTransactionId: t.external_transaction_id,
      walletId: t.wallet_id,
      kind: t.kind,
      status: t.status,
      failureCode: t.failure_code ?? undefined,
      money: money(t.amount_cents, t.currency),
      balance: t.balance_after_cents ? money(t.balance_after_cents, t.currency) : undefined,
      referenceExternalTransactionId: t.reference_external_transaction_id ?? undefined,
    };
  }

  @Get('wagering/transactions/:transactionId')
  async transaction(@Param('transactionId') id: string) {
    const [t] = await this.rows(`${this.txSelect} WHERE id = ?::uuid`, [uuid(id, 'transactionId')]);
    if (!t) throw new NotFoundError('transação');
    return this.txBody(t);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
  ) {
    const [t] = await this.rows(
      `${this.txSelect} WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalId],
    );
    if (!t) throw new NotFoundError('transação');
    return this.txBody(t);
  }

  /** Recalcula o saldo pelo ledger. Divergência NÃO é corrigida: é logada e sinalizada. */
  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    uuid(walletId, 'walletId');
    const [r] = await this.rows(
      `SELECT w.currency, w.balance_cents::text AS stored,
              (SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_cents ELSE -amount_cents END), 0)
                 FROM wallet_ledger_entry WHERE wallet_id = w.id)::text AS calculated,
              (SELECT count(*)::int FROM wallet_ledger_entry WHERE wallet_id = w.id) AS entries
       FROM wallet w WHERE w.id = ?::uuid`,
      [walletId],
    );
    if (!r) throw new WalletNotFoundError(walletId);
    const diff = BigInt(r.stored) - BigInt(r.calculated);
    const consistent = diff === 0n;
    if (!consistent) {
      inc('wager_reconciliation_divergences_total');
      console.log(
        JSON.stringify({ level: 'error', event: 'reconciliation_divergence', walletId, difference: dec(diff.toString()) }),
      );
    }
    return {
      walletId,
      storedBalance: money(r.stored, r.currency),
      calculatedBalance: money(r.calculated, r.currency),
      difference: money(diff.toString(), r.currency),
      consistent,
      checkedEntries: r.entries,
    };
  }
}