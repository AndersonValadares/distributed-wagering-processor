import { createHash } from 'node:crypto';
import type { Money } from '../shared/money.ts';

export type HashableFields = {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId: string | undefined;
};

/** SHA-256 de um JSON canônico (chaves em ordem alfabética) dos campos de negócio. */
export function computePayloadHash(fields: HashableFields): string {
  const canonical: Record<string, string | null> = {
    amount: fields.money.toDecimal(),
    currency: fields.money.currency,
    externalTransactionId: fields.externalTransactionId,
    gameId: fields.gameId,
    kind: fields.kind,
    playerId: fields.playerId,
    providerId: fields.providerId,
    referenceExternalTransactionId: fields.referenceExternalTransactionId ?? null,
    roundId: fields.roundId,
    walletId: fields.walletId,
  };
  const sorted = Object.fromEntries(
    Object.entries(canonical).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
