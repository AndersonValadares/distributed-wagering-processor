import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module.ts';
import { MikroORM } from '@mikro-orm/postgresql';

let app!: INestApplication;
let base = '';
const PROVIDER = `provider-q-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(async () => {
  await app.close();
});

const json = (path: string, init?: RequestInit) => fetch(base + path, init);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function setup() {
  const playerId = crypto.randomUUID();
  const w = (await (
    await post('/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })
  ).json()) as any;
  return { id: w.id as string, playerId };
}

async function bet(w: { id: string; playerId: string }, ext: string, amount = '10.00') {
  const res = await post(
    '/wagering/transactions',
    {
      providerId: PROVIDER, externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
      roundId: 'r', gameId: 'g', kind: 'BET', money: { amount, currency: 'BRL' },
    },
    { 'idempotency-key': `${PROVIDER}:${ext}` },
  );
  return (await res.json()) as any;
}

describe('consultas', () => {
  test('GET wallet, transação por id e por provider', async () => {
    const w = await setup();
    const t = await bet(w, 'b1');
    const wallet = (await (await json(`/wallets/${w.id}`)).json()) as any;
    expect(wallet.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(wallet.version).toBe(2);

    const byId = (await (await json(`/wagering/transactions/${t.transactionId}`)).json()) as any;
    expect(byId.status).toBe('PROCESSED');
    const byExt = (await (await json(`/providers/${PROVIDER}/wagering/transactions/b1`)).json()) as any;
    expect(byExt.transactionId).toBe(t.transactionId);
  });

  test('inexistentes: 404; id malformado: 400', async () => {
    expect((await json(`/wallets/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await json(`/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await json(`/providers/${PROVIDER}/wagering/transactions/nao-existe`)).status).toBe(404);
    expect((await json(`/wallets/xyz`)).status).toBe(400);
  });

  test('ledger paginado por cursor, sem repetir nem perder itens', async () => {
    const w = await setup();
    for (let i = 0; i < 4; i++) await bet(w, `p${i}`, '5.00');
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/wallets/${w.id}/ledger?limit=2` + (cursor ? `&cursor=${cursor}` : '');
      const page = (await (await json(url)).json()) as any;
      for (const item of page.items) seen.push(item.id);
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen.length).toBe(5); // OPENING + 4 apostas
    expect(new Set(seen).size).toBe(5);
    expect((await json(`/wallets/${w.id}/ledger?cursor=lixo`)).status).toBe(400);
  });
    test('wallet com saldo divergente do ledger: consistent false, sem correção silenciosa', async () => {
    const w = await setup();
    const orm = app.get(MikroORM);
    await orm.em.fork().execute(
      `UPDATE wallet SET balance_cents = balance_cents + 500 WHERE id = ?::uuid`,
      [w.id],
    );
    const res = await post(`/wallets/${w.id}/reconciliation`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.consistent).toBe(false);
    expect(body.difference.amount).toBe('5.00');

    // não foi corrigida: o saldo armazenado continua divergente
    const again = (await (await post(`/wallets/${w.id}/reconciliation`, {})).json()) as any;
    expect(again.consistent).toBe(false);

    const metrics = await (await fetch(base + '/metrics')).text();
    expect(metrics).toContain('wager_reconciliation_divergences_total');
  });
});

describe('reconciliação', () => {
  test('wallet consistente', async () => {
    const w = await setup();
    await bet(w, 'r1', '30.00');
    const res = await post(`/wallets/${w.id}/reconciliation`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.consistent).toBe(true);
    expect(body.difference.amount).toBe('0.00');
    expect(body.checkedEntries).toBe(2);
  });
});
