import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../app.module.ts';

let app!: INestApplication;
let base = '';
let orm!: MikroORM;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0); // porta livre qualquer
  base = await app.getUrl();
  orm = app.get(MikroORM);
});
afterAll(async () => {
  await app.close();
});

const post = (path: string, body: unknown) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const wallet = (playerId: string, amount: unknown = '1000.00', currency = 'BRL') => ({
  playerId,
  initialBalance: { amount, currency },
});

async function rows(sql: string, params: unknown[]) {
  return (await orm.em.execute(sql, params)) as unknown as Record<string, any>[];
}

describe('POST /wallets', () => {
  test('cria a wallet com OPENING e um lançamento CREDIT, e o saldo bate com o ledger', async () => {
    const playerId = crypto.randomUUID();
    const res = await post('/wallets', wallet(playerId));
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.playerId).toBe(playerId);
    expect(body.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(body.version).toBe(1);

    const ledger = await rows(
      `SELECT direction, amount_cents::text AS amount FROM wallet_ledger_entry WHERE wallet_id = ?::uuid`,
      [body.id],
    );
    expect(ledger).toEqual([{ direction: 'CREDIT', amount: '100000' }]);
    const opening = await rows(
      `SELECT status FROM wager_transaction WHERE wallet_id = ?::uuid AND kind = 'OPENING'`,
      [body.id],
    );
    expect(opening).toEqual([{ status: 'PROCESSED' }]);
  });

  test('wallet duplicada para o mesmo player e moeda é 409', async () => {
    const playerId = crypto.randomUUID();
    expect((await post('/wallets', wallet(playerId))).status).toBe(201);
    const second = await post('/wallets', wallet(playerId));
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('10 criações simultâneas do mesmo player: uma 201 e nove 409', async () => {
    const playerId = crypto.randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post('/wallets', wallet(playerId))),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201).length).toBe(1);
    expect(statuses.filter((s) => s === 409).length).toBe(9);
    const [row] = await rows(`SELECT count(*)::int AS n FROM wallet WHERE player_id = ?::uuid`, [playerId]);
    expect(row!.n).toBe(1);
  });

  test('payload inválido é sempre 400', async () => {
    const id = crypto.randomUUID();
    const invalid: unknown[] = [
      wallet(id, 1000), // número no lugar de texto
      wallet(id, '1e3'), // notação científica
      wallet(id, '-5.00'), // negativo
      wallet(id, '10.123'), // 3 casas decimais
      wallet(id, ''), // vazio
      wallet(id, '10.00', 'brl'), // moeda inválida
      wallet('nao-e-uuid'),
      {},
      { playerId: id },
    ];
    for (const body of invalid) {
      const res = await post('/wallets', body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toBeDefined();
    }
  });

  test('saldo inicial zero cria a wallet sem OPENING e sem lançamento', async () => {
    const res = await post('/wallets', wallet(crypto.randomUUID(), '0.00'));
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    const [row] = await rows(
      `SELECT count(*)::int AS n FROM wallet_ledger_entry WHERE wallet_id = ?::uuid`,
      [body.id],
    );
    expect(row!.n).toBe(0);
  });
});