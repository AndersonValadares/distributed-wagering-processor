import { describe, expect, test } from 'bun:test';
import { Money } from '../shared/money.ts';
import {
  InvalidTransactionStateError,
  LedgerDirection,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  WagerTransactionValidationError,
  type CreateWagerTransactionProps,
} from './wager-transaction.ts';

function build(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.fromDecimal('25.00', 'BRL'),
    referenceExternalTransactionId: undefined,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
}

describe('WagerTransaction: criação', () => {
  test('nasce em PENDING', () => {
    expect(build().status).toBe(WagerTransactionStatus.Pending);
  });

  test('OPENING não pode ser submetido', () => {
    expect(() => build({ kind: WagerTransactionKind.Opening })).toThrow(
      WagerTransactionValidationError,
    );
  });

  test('REFUND e ROLLBACK exigem referência', () => {
    expect(() => build({ kind: WagerTransactionKind.Refund })).toThrow(
      WagerTransactionValidationError,
    );
    expect(() => build({ kind: WagerTransactionKind.Rollback })).toThrow(
      WagerTransactionValidationError,
    );
  });

  test('BET com valor zero é recusada, LOSS com zero é aceita', () => {
    const zero = Money.fromDecimal('0.00', 'BRL');
    expect(() => build({ money: zero })).toThrow(WagerTransactionValidationError);
    expect(() => build({ kind: WagerTransactionKind.Loss, money: zero })).not.toThrow();
  });
});

describe('WagerTransaction: transições', () => {
  test('PENDING vai para PROCESSED', () => {
    const tx = build();
    const at = new Date('2026-01-01T00:00:01Z');
    tx.markProcessed(undefined, at);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toEqual(at);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING vai para PENDING_REFERENCE e depois PROCESSED', () => {
    const tx = build({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-0',
    });
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('tx-0', new Date());
    expect(tx.referenceTransactionId).toBe('tx-0');
  });

  test('reject guarda o failureCode', () => {
    const tx = build();
    tx.reject('INSUFFICIENT_FUNDS');
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('estados terminais não mudam mais', () => {
    const tx = build();
    tx.reject('INSUFFICIENT_FUNDS');
    expect(() => tx.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject('INTERNAL_ERROR')).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail('INTERNAL_ERROR')).toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
  });

  test('markPendingReference só vale a partir de PENDING', () => {
    const tx = build();
    tx.markProcessed(undefined, new Date());
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction: consultas de domínio', () => {
  test('LOSS não afeta saldo; BET afeta', () => {
    expect(build({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
    expect(build().affectsBalance()).toBe(true);
  });

  test('só REFUND e ROLLBACK exigem referência', () => {
    expect(build().requiresReference()).toBe(false);
    const refund = build({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-0',
    });
    expect(refund.requiresReference()).toBe(true);
  });

  test('matchesPayload compara o hash', () => {
    const tx = build();
    expect(tx.matchesPayload('hash-1')).toBe(true);
    expect(tx.matchesPayload('hash-2')).toBe(false);
  });

  test('direção do ledger: BET debita, WIN e REFUND creditam', () => {
    expect(build().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(build({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    const refund = build({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-0',
    });
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK é o inverso da referência', () => {
    const bet = build();
    const win = build({ kind: WagerTransactionKind.Win });
    const rollback = build({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-0',
    });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(WagerTransactionValidationError);
  });

  test('LOSS não gera lançamento', () => {
    expect(() => build({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow(
      WagerTransactionValidationError,
    );
  });
});
