import { Money } from '../shared/money.ts';

export class ValidationError extends Error {
  readonly code = 'INVALID_REQUEST';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${name} deve ser um objeto JSON`);
  }
  return value as Record<string, unknown>;
}

export function asString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} é obrigatório e deve ser um texto`);
  }
  return value;
}

export function asUuid(obj: Record<string, unknown>, field: string): string {
  const value = asString(obj, field);
  if (!UUID.test(value)) throw new ValidationError(`${field} deve ser um UUID`);
  return value;
}

/** Aceita só { amount: "25.00", currency: "BRL" }. Número em amount é recusado. */
export function asMoney(obj: Record<string, unknown>, field: string): Money {
  const money = asObject(obj[field], field);
  return Money.fromDecimal(asString(money, 'amount'), asString(money, 'currency'));
}