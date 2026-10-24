import { describe, expect, test } from 'bun:test';
import { Money, MoneyError } from './money.ts';

/** Devolve o código do MoneyError lançado, ou 'NONE' se não lançou. */
function errorCodeOf(fn: () => unknown): string {
  try {
    fn();
    return 'NONE';
  } catch (error) {
    return error instanceof MoneyError ? error.code : 'OTHER';
  }
}

describe('Money: escala e conversão', () => {
  test('converte texto decimal para centavos sem usar number', () => {
    expect(Money.fromDecimal('25.00', 'BRL').cents).toBe(2500n);
    expect(Money.fromDecimal('25.5', 'BRL').cents).toBe(2550n);
    expect(Money.fromDecimal('25', 'BRL').cents).toBe(2500n);
    expect(Money.fromDecimal('0.01', 'BRL').cents).toBe(1n);
  });

  test('0.10 + 0.20 é exatamente 0.30', () => {
    const total = Money.fromDecimal('0.10', 'BRL').add(Money.fromDecimal('0.20', 'BRL'));
    expect(total.toDecimal()).toBe('0.30');
  });

  test('toDecimal devolve sempre duas casas', () => {
    expect(Money.fromCents(5n, 'USD').toDecimal()).toBe('0.05');
    expect(Money.fromCents(1234567n, 'USD').toDecimal()).toBe('12345.67');
  });
});

describe('Money: entradas inválidas', () => {
  test.each(['-1', '-0.01', '1.234', '1,50', '1e3', '', 'abc', ' 10', '10.'])(
    'recusa valor %p',
    (value) => {
      expect(errorCodeOf(() => Money.fromDecimal(value, 'BRL'))).toBe('INVALID_AMOUNT');
    },
  );

  test('fromCents recusa negativos', () => {
    expect(errorCodeOf(() => Money.fromCents(-1n, 'BRL'))).toBe('INVALID_AMOUNT');
  });

  test.each(['br', 'BRL1', 'brl', 'REAL', ''])('recusa moeda %p', (currency) => {
    expect(errorCodeOf(() => Money.fromCents(100n, currency))).toBe('INVALID_CURRENCY');
  });
});

describe('Money: operações', () => {
  test('soma na mesma moeda', () => {
    const a = Money.fromDecimal('10.00', 'BRL');
    const b = Money.fromDecimal('5.50', 'BRL');
    expect(a.add(b).toDecimal()).toBe('15.50');
  });

  test('subtração que zera o valor é permitida', () => {
    const a = Money.fromDecimal('10.00', 'BRL');
    expect(a.subtract(a).isZero()).toBe(true);
  });

  test('subtração que resultaria em negativo é recusada', () => {
    const a = Money.fromDecimal('10.00', 'BRL');
    const b = Money.fromDecimal('10.01', 'BRL');
    expect(errorCodeOf(() => a.subtract(b))).toBe('NEGATIVE_RESULT');
  });

  test('soma e subtração com moedas diferentes são recusadas', () => {
    const brl = Money.fromDecimal('10.00', 'BRL');
    const usd = Money.fromDecimal('10.00', 'USD');
    expect(errorCodeOf(() => brl.add(usd))).toBe('CURRENCY_MISMATCH');
    expect(errorCodeOf(() => brl.subtract(usd))).toBe('CURRENCY_MISMATCH');
  });

  test('equals compara valor e moeda', () => {
    expect(Money.fromDecimal('1.00', 'BRL').equals(Money.fromCents(100n, 'BRL'))).toBe(true);
    expect(Money.fromDecimal('1.00', 'BRL').equals(Money.fromCents(100n, 'USD'))).toBe(false);
  });
});
