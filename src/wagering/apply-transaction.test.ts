import { describe, expect, test } from 'bun:test';
import { Money } from '../shared/money.ts';
import { Wallet } from '../wallet/wallet.ts';
import { applyTransaction } from './apply-transaction.ts';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from './wager-transaction.ts';

const brl = (v: string) => Money.fromDecimal(v, 'BRL');
const now = new Date('2026-01-01T00:00:00Z');

function wallet(balance = '100.00'): Wallet {
  return Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(balance), at: now });
}

function build(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx',
    providerId: 'provider-a',
    externalTransactionId: 'ext-tx',
    idempotencyKey: 'provider-a:ext-tx',
    payloadHash: 'hash',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'r-1',
    gameId: 'g-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    createdAt: now,
    ...overrides,
  });
}

/** Uma transação anterior, já PROCESSED, para servir de referência. */
function processed(kind: (typeof Kind)[keyof typeof Kind], amount = '25.00'): WagerTransaction {
  const ref = build({ id: 'ref', externalTransactionId: 'ext-ref', kind, money: brl(amount) });
  ref.markProcessed(undefined, now);
  return ref;
}

function reversal(kind: typeof Kind.Refund | typeof Kind.Rollback, amount = '25.00') {
  return build({
    kind,
    money: brl(amount),
    referenceExternalTransactionId: 'ext-ref',
  });
}

function run(
  tx: WagerTransaction,
  opts: { wallet?: Wallet; reference?: WagerTransaction; reversed?: boolean } = {},
) {
  return applyTransaction({
    transaction: tx,
    wallet: opts.wallet ?? wallet(),
    reference: opts.reference,
    referenceAlreadyReversed: opts.reversed ?? false,
    entryId: 'entry-1',
    now,
  });
}

describe('applyTransaction: BET, WIN e LOSS', () => {
  test('BET com saldo debita e gera lançamento DEBIT', () => {
    const tx = build();
    const out = run(tx);
    expect(out.type).toBe('PROCESSED');
    if (out.type !== 'PROCESSED') return;
    expect(out.wallet.balance.toDecimal()).toBe('75.00');
    expect(out.entry?.direction).toBe('DEBIT');
    expect(tx.status).toBe(Status.Processed);
  });

  test('BET sem saldo é REJECTED com INSUFFICIENT_FUNDS e nada muda', () => {
    const tx = build({ money: brl('100.01') });
    const w = wallet();
    const out = run(tx, { wallet: w });
    expect(out).toEqual({ type: 'REJECTED', code: 'INSUFFICIENT_FUNDS' });
    expect(tx.status).toBe(Status.Rejected);
    expect(w.balance.toDecimal()).toBe('100.00');
  });

  test('WIN credita e gera lançamento CREDIT', () => {
    const out = run(build({ kind: Kind.Win }));
    expect(out.type).toBe('PROCESSED');
    if (out.type !== 'PROCESSED') return;
    expect(out.wallet.balance.toDecimal()).toBe('125.00');
    expect(out.entry?.direction).toBe('CREDIT');
  });

  test('LOSS é PROCESSED, sem lançamento e sem mudar a version', () => {
    const w = wallet();
    const out = run(build({ kind: Kind.Loss }), { wallet: w });
    expect(out.type).toBe('PROCESSED');
    if (out.type !== 'PROCESSED') return;
    expect(out.entry).toBeUndefined();
    expect(out.wallet.version).toBe(w.version);
  });

  test('moeda diferente da wallet é REJECTED com CURRENCY_MISMATCH', () => {
    const tx = build({ money: Money.fromDecimal('10.00', 'USD') });
    expect(run(tx)).toEqual({ type: 'REJECTED', code: 'CURRENCY_MISMATCH' });
  });
});

describe('applyTransaction: REFUND e ROLLBACK', () => {
  test('referência ausente vira PENDING_REFERENCE', () => {
    const tx = reversal(Kind.Refund);
    expect(run(tx)).toEqual({ type: 'PENDING_REFERENCE' });
    expect(tx.status).toBe(Status.PendingReference);
  });

  test('reprocessar depois que a referência chegou aplica normalmente', () => {
    const tx = reversal(Kind.Refund);
    run(tx);
    const out = run(tx, { reference: processed(Kind.Bet), wallet: wallet('75.00') });
    expect(out.type).toBe('PROCESSED');
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('ref');
  });

  test('REFUND de uma BET devolve o valor', () => {
    const out = run(reversal(Kind.Refund), { reference: processed(Kind.Bet) });
    expect(out.type).toBe('PROCESSED');
    if (out.type !== 'PROCESSED') return;
    expect(out.wallet.balance.toDecimal()).toBe('125.00');
  });

  test('REFUND só referencia BET', () => {
    const out = run(reversal(Kind.Refund), { reference: processed(Kind.Win) });
    expect(out).toEqual({ type: 'REJECTED', code: 'INVALID_REFERENCE_KIND' });
  });

  test('referência de outra rodada é REFERENCE_MISMATCH', () => {
    const ref = build({ id: 'ref', externalTransactionId: 'ext-ref', roundId: 'r-OUTRA' });
    ref.markProcessed(undefined, now);
    const out = run(reversal(Kind.Refund), { reference: ref });
    expect(out).toEqual({ type: 'REJECTED', code: 'REFERENCE_MISMATCH' });
  });

  test('referência já revertida é ALREADY_REVERSED', () => {
    const out = run(reversal(Kind.Refund), { reference: processed(Kind.Bet), reversed: true });
    expect(out).toEqual({ type: 'REJECTED', code: 'ALREADY_REVERSED' });
  });

  test('valor diferente da referência é AMOUNT_MISMATCH', () => {
    const out = run(reversal(Kind.Refund, '10.00'), { reference: processed(Kind.Bet) });
    expect(out).toEqual({ type: 'REJECTED', code: 'AMOUNT_MISMATCH' });
  });

  test('ROLLBACK de uma WIN debita o valor', () => {
    const out = run(reversal(Kind.Rollback), { reference: processed(Kind.Win) });
    expect(out.type).toBe('PROCESSED');
    if (out.type !== 'PROCESSED') return;
    expect(out.wallet.balance.toDecimal()).toBe('75.00');
    expect(out.entry?.direction).toBe('DEBIT');
  });

  test('ROLLBACK que deixaria saldo negativo é REVERSAL_WOULD_OVERDRAW', () => {
    const out = run(reversal(Kind.Rollback), {
      reference: processed(Kind.Win),
      wallet: wallet('10.00'),
    });
    expect(out).toEqual({ type: 'REJECTED', code: 'REVERSAL_WOULD_OVERDRAW' });
  });

  test('ROLLBACK de uma BET devolve o valor', () => {
    const out = run(reversal(Kind.Rollback), { reference: processed(Kind.Bet) });
    expect(out.type).toBe('PROCESSED');
    if (out.type !== 'PROCESSED') return;
    expect(out.wallet.balance.toDecimal()).toBe('125.00');
  });

  test('ROLLBACK de uma LOSS não é permitido', () => {
    const out = run(reversal(Kind.Rollback), { reference: processed(Kind.Loss) });
    expect(out).toEqual({ type: 'REJECTED', code: 'INVALID_REFERENCE_KIND' });
  });

  test('referência REJECTED vira REFERENCE_NOT_PROCESSED', () => {
    const ref = build({ id: 'ref', externalTransactionId: 'ext-ref' });
    ref.reject('INSUFFICIENT_FUNDS');
    const out = run(reversal(Kind.Refund), { reference: ref });
    expect(out).toEqual({ type: 'REJECTED', code: 'REFERENCE_NOT_PROCESSED' });
  });

  test('referência ainda PENDING_REFERENCE faz a reversão esperar', () => {
    const ref = build({
      id: 'ref',
      externalTransactionId: 'ext-ref',
      kind: Kind.Refund,
      referenceExternalTransactionId: 'ext-0',
    });
    ref.markPendingReference();
    const out = run(reversal(Kind.Rollback), { reference: ref });
    expect(out).toEqual({ type: 'PENDING_REFERENCE' });
  });
});
