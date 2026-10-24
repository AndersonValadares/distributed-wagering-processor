import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../app.module.ts';

let app!: INestApplication;
let base = '';
let orm!: MikroORM;
const PROVIDER = `provider-http-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
  orm = app.get(MikroORM);
});
afterAll(async () => {
  await app.close();
});

async function newWallet(amount = '100.00') {
  const playerId = crypto.randomUUID();
  const res = await fetch(base + '/wallets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  const body = (await res.json()) as any;
  return { id: body.id as string, playerId };
}

type W = Awaited<ReturnType<typeof newWallet>>;

function payload(w: W, ext: string, amount: unknown, extra: Record<string, unknown> = {}) {
  return {
    providerId: PROVIDER,
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

/** key undefined = usa o padrão provider:externalId; key null = não envia o header. */
function send(body: unknown, key?: string | null) {
  const ext = (body as any)?.externalTransactionId;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const idem = key === undefined ? `${PROVIDER}:${ext}` : key;
  if (idem !== null) headers['idempotency-key'] = idem;
  return fetch(base + '/wagering/transactions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function ledgerCount(walletId: string): Promise<number> {
  const [row] = (await orm.em.execute(
    `SELECT count(*)::int AS n FROM wallet_ledger_entry WHERE wallet_id = ?::uuid`,
    [walletId],
  )) as unknown as { n: number }[];
  return row!.n;
}

describe('POST /wagering/transactions: status HTTP', () => {
  test('BET com saldo: 200, PROCESSED e saldo atualizado', async () => {
    const w = await newWallet('100.00');
    const res = await send(payload(w, 'bet-1', '25.00'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(body.idempotentReplay).toBe(false);
  });

  test('reenvio idêntico: 200 com idempotentReplay true e o mesmo saldo', async () => {
    const w = await newWallet('100.00');
    const first = (await (await send(payload(w, 'bet-2', '25.00'))).json()) as any;
    const res = await send(payload(w, 'bet-2', '25.00'));
    expect(res.status).toBe(200);
    const second = (await res.json()) as any;
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balance).toEqual({ amount: '75.00', currency: 'BRL' });
  });

  test('BET sem saldo: 422 com failureCode e providerAction', async () => {
    const w = await newWallet('10.00');
    const res = await send(payload(w, 'bet-3', '80.00'));
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(body.providerAction).toBe('GIVE_UP');
  });

  test('REFUND antes da BET: 202 com PENDING_REFERENCE', async () => {
    const w = await newWallet('100.00');
    const res = await send(
      payload(w, 'refund-1', '25.00', { kind: 'REFUND', referenceExternalTransactionId: 'bet-x' }),
    );
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).status).toBe('PENDING_REFERENCE');
  });

  test('mesma key com payload diferente: 409', async () => {
    const w = await newWallet('100.00');
    expect((await send(payload(w, 'bet-4', '25.00'))).status).toBe(200);
    const res = await send(payload(w, 'bet-4', '30.00'));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('wallet inexistente: 404', async () => {
    const ghost: W = { id: crypto.randomUUID(), playerId: crypto.randomUUID() };
    const res = await send(payload(ghost, 'bet-5', '10.00'));
    expect(res.status).toBe(404);
  });

  test('payload inválido: sempre 400', async () => {
    const w = await newWallet('100.00');
    const cases: unknown[] = [
      payload(w, 'bad-1', 25), // amount número
      payload(w, 'bad-2', '1e3'), // notação científica
      payload(w, 'bad-3', '-5.00'), // negativo
      payload(w, 'bad-4', '10.123'), // 3 casas
      payload(w, 'bad-5', '10.00', { kind: 'OPENING' }), // interno
      payload(w, 'bad-6', '10.00', { kind: 'XYZ' }), // desconhecido
      payload(w, 'bad-7', '10.00', { kind: 'REFUND' }), // sem referência
      payload(w, 'bad-8', '10.00', { walletId: 'nao-e-uuid' }),
      { providerId: PROVIDER },
    ];
    for (const body of cases) {
      const res = await send(body);
      expect(res.status).toBe(400);
    }
  });

  test('sem o header Idempotency-Key: 400', async () => {
    const w = await newWallet('100.00');
    const res = await send(payload(w, 'bet-6', '10.00'), null);
    expect(res.status).toBe(400);
  });
});

describe('POST /wagering/transactions: concorrência via HTTP', () => {
  test('duas apostas de 80.00 sobre saldo 100.00: um 200 e um 422, saldo final 20.00', async () => {
    const w = await newWallet('100.00');
    const [a, b] = await Promise.all([
      send(payload(w, 'race-a', '80.00')),
      send(payload(w, 'race-b', '80.00')),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    expect(await ledgerCount(w.id)).toBe(2); // OPENING (crédito) + um único débito
    const [row] = (await orm.em.execute(
      `SELECT balance_cents::text AS c FROM wallet WHERE id = ?::uuid`,
      [w.id],
    )) as unknown as { c: string }[];
    expect(row!.c).toBe('2000');
  });

  test('a mesma aposta 50 vezes em paralelo: um único débito', async () => {
    const w = await newWallet('100.00');
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => send(payload(w, 'race-50', '25.00'))),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as any[];
    expect(bodies.filter((b) => !b.idempotentReplay).length).toBe(1);
    expect(await ledgerCount(w.id)).toBe(2); // OPENING + um débito
  });
});