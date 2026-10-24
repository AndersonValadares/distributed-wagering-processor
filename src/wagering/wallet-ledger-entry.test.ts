import { describe, expect, test } from 'bun:test';
import { Money } from '../shared/money.ts';
import { LedgerEntryError, WalletLedgerEntry, type LedgerEntryState } from './wallet-ledger-entry.ts';
import { LedgerDirection } from './wager-transaction.ts';

const brl = (v: string) => Money.fromDecimal(v, 'BRL');

function state(overrides: Partial<LedgerEntryState> = {}): LedgerEntryState {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('WalletLedgerEntry: criação', () => {
  test('débito com conta certa é aceito', () => {
    const entry = WalletLedgerEntry.create(state());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toDecimal()).toBe('75.00');
  });

  test('crédito com conta certa é aceito', () => {
    const entry = WalletLedgerEntry.create(
      state({
        direction: LedgerDirection.Credit,
        balanceBefore: brl('75.00'),
        balanceAfter: brl('100.00'),
      }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  test('aritmética errada é recusada', () => {
    expect(() => WalletLedgerEntry.create(state({ balanceAfter: brl('80.00') }))).toThrow(
      LedgerEntryError,
    );
    expect(() =>
      WalletLedgerEntry.create(
        state({ direction: LedgerDirection.Credit, balanceAfter: brl('75.00') }),
      ),
    ).toThrow(LedgerEntryError);
  });

  test('débito maior que o saldo anterior é recusado', () => {
    expect(() =>
      WalletLedgerEntry.create(
        state({ money: brl('150.00'), balanceBefore: brl('100.00'), balanceAfter: brl('0.00') }),
      ),
    ).toThrow(LedgerEntryError);
  });

  test('valor zero é recusado', () => {
    expect(() => WalletLedgerEntry.create(state({ money: brl('0.00') }))).toThrow(
      LedgerEntryError,
    );
  });
});

describe('WalletLedgerEntry: imutabilidade', () => {
  test('não tem métodos de transição e o estado não aceita alteração', () => {
    const entry = WalletLedgerEntry.create(state());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry));
    expect(methods.filter((m) => /^(set|mark|update|change|apply)/.test(m))).toEqual([]);

    expect(() => {
      (entry as unknown as { state: { balanceAfter: Money } }).state.balanceAfter = brl('1.00');
    }).toThrow();
    expect(entry.balanceAfter.toDecimal()).toBe('75.00');
  });

  test('rehydrate reconstrói sem revalidar', () => {
    const entry = WalletLedgerEntry.rehydrate(state());
    expect(entry.id).toBe('entry-1');
    expect(entry.direction).toBe(LedgerDirection.Debit);
  });
});
