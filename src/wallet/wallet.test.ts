import { describe, expect, test } from 'bun:test';
import { Money } from '../shared/money.ts';
import { LedgerDirection } from '../wagering/wager-transaction.ts';
import { LedgerEntryError } from '../wagering/wallet-ledger-entry.ts';
import { Wallet, WalletError } from './wallet.ts';

const brl = (v: string) => Money.fromDecimal(v, 'BRL');
const usd = (v: string) => Money.fromDecimal(v, 'USD');
const at = new Date('2026-01-01T00:00:00Z');

function open(balance = '100.00'): Wallet {
  return Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(balance), at });
}

function move(amount: Money, n = 1) {
  return { amount, transactionId: `tx-${n}`, entryId: `e-${n}`, at };
}

describe('Wallet: abertura', () => {
  test('open começa com version 1 e o saldo inicial', () => {
    const wallet = open();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toDecimal()).toBe('100.00');
    expect(wallet.currency).toBe('BRL');
  });

  test('rehydrate reconstrói o estado sem mexer na version', () => {
    const wallet = Wallet.rehydrate({
      id: 'w-9',
      playerId: 'p-9',
      balance: brl('50.00'),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.id).toBe('w-9');
    expect(wallet.version).toBe(7);
  });
});

describe('Wallet: crédito e débito', () => {
  test('crédito aumenta o saldo e gera lançamento CREDIT', () => {
    const { wallet, entry } = open().credit(move(brl('25.00')));
    expect(wallet.balance.toDecimal()).toBe('125.00');
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('débito reduz o saldo e gera lançamento DEBIT', () => {
    const { wallet, entry } = open().debit(move(brl('25.00')));
    expect(wallet.balance.toDecimal()).toBe('75.00');
    expect(entry.direction).toBe(LedgerDirection.Debit);
  });

  test('débito de valor exato zera o saldo', () => {
    const { wallet } = open().debit(move(brl('100.00')));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('débito acima do saldo lança INSUFFICIENT_FUNDS', () => {
    try {
      open().debit(move(brl('100.01')));
      throw new Error('deveria ter lançado');
    } catch (e) {
      expect(e).toBeInstanceOf(WalletError);
      expect((e as WalletError).code).toBe('INSUFFICIENT_FUNDS');
    }
  });

  test('operações devolvem nova wallet e não alteram a original', () => {
    const original = open();
    original.debit(move(brl('10.00')));
    expect(original.balance.toDecimal()).toBe('100.00');
    expect(original.version).toBe(1);
  });

  test('version sobe 1 a cada movimentação', () => {
    const w2 = open().debit(move(brl('10.00'), 1)).wallet;
    const w3 = w2.credit(move(brl('5.00'), 2)).wallet;
    expect(w2.version).toBe(2);
    expect(w3.version).toBe(3);
  });
});

describe('Wallet: moedas', () => {
  test('débito com moeda diferente lança CURRENCY_MISMATCH', () => {
    try {
      open().debit(move(usd('1.00')));
      throw new Error('deveria ter lançado');
    } catch (e) {
      expect((e as WalletError).code).toBe('CURRENCY_MISMATCH');
    }
  });

  test('crédito com moeda diferente lança CURRENCY_MISMATCH', () => {
    try {
      open().credit(move(usd('1.00')));
      throw new Error('deveria ter lançado');
    } catch (e) {
      expect((e as WalletError).code).toBe('CURRENCY_MISMATCH');
    }
  });
});

describe('Wallet: saldo e ledger andam juntos', () => {
  test('o lançamento bate exatamente com a mudança de saldo', () => {
    const before = open();
    const { wallet, entry } = before.debit(move(brl('30.00')));
    expect(entry.walletId).toBe(wallet.id);
    expect(entry.transactionId).toBe('tx-1');
    expect(entry.balanceBefore.equals(before.balance)).toBe(true);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  test('valor zero é recusado e nada muda', () => {
    const wallet = open();
    expect(() => wallet.credit(move(brl('0.00')))).toThrow(LedgerEntryError);
    expect(wallet.version).toBe(1);
  });
});
