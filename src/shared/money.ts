export type MoneyErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'NEGATIVE_RESULT';

export class MoneyError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;

function assertCurrency(currency: string): string {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new MoneyError('INVALID_CURRENCY', `moeda inválida: ${currency}`);
  }
  return currency;
}

export class Money {
  private constructor(
    readonly cents: bigint,
    readonly currency: string,
  ) {}

  /** Valor já em centavos. Não aceita negativos. */
  static fromCents(cents: bigint, currency: string): Money {
    if (cents < 0n) {
      throw new MoneyError('INVALID_AMOUNT', 'valor não pode ser negativo');
    }
    return new Money(cents, assertCurrency(currency));
  }

  /** Texto decimal, como "25.00" ou "25.5". Sem notação científica, sem vírgula, sem sinal. */
  static fromDecimal(value: string, currency: string): Money {
    if (!DECIMAL_PATTERN.test(value)) {
      throw new MoneyError('INVALID_AMOUNT', `valor inválido: ${value}`);
    }
    const [whole = '0', fraction = ''] = value.split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    return new Money(cents, assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    if (other.cents > this.cents) {
      throw new MoneyError('NEGATIVE_RESULT', 'subtração resultaria em valor negativo');
    }
    return new Money(this.cents - other.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  equals(other: Money): boolean {
    return this.cents === other.cents && this.currency === other.currency;
  }

  toDecimal(): string {
    const whole = this.cents / 100n;
    const fraction = this.cents % 100n;
    return `${whole}.${fraction.toString().padStart(2, '0')}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError(
        'CURRENCY_MISMATCH',
        `moedas diferentes: ${this.currency} e ${other.currency}`,
      );
    }
  }
}
