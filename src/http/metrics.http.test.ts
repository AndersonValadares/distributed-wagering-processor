import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module.ts';

let app!: INestApplication;
let base = '';
const PROVIDER = `provider-m-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(async () => {
  await app.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('GET /metrics', () => {
  test('expõe transações por status, duplicatas, latência e outbox', async () => {
    const playerId = crypto.randomUUID();
    const w = (await (
      await post('/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })
    ).json()) as any;
    const bet = {
      providerId: PROVIDER, externalTransactionId: 'm1', playerId, walletId: w.id,
      roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '10.00', currency: 'BRL' },
    };
    const headers = { 'idempotency-key': `${PROVIDER}:m1` };
    await post('/wagering/transactions', bet, headers);
    await post('/wagering/transactions', bet, headers); // replay

    const res = await fetch(base + '/metrics');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('wager_transactions{status="PROCESSED"}');
    expect(text).toContain('wager_duplicates_total{source="idempotency"}');
    expect(text).toContain('wager_processing_latency_ms_count');
    expect(text).toContain('wager_outbox_lag_seconds');
    expect(text).toContain('wager_outbox_pending');
  });
});