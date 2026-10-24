import { afterAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Defina DATABASE_URL antes de rodar este teste');

const orm = await MikroORM.init({
  clientUrl: url,
  entities: [],
  discovery: { warnWhenNoEntities: false },
});
afterAll(async () => {
  await orm.close();
});

import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('./instance-runner.ts', import.meta.url));

async function createWallet(cents: string) {
  const id = crypto.randomUUID();
  const playerId = crypto.randomUUID();
  await orm.em.execute(
    `INSERT INTO wallet (id, player_id, currency, balance_cents) VALUES (?::uuid, ?::uuid, 'BRL', ?::bigint)`,
    [id, playerId, cents],
  );
  return { id, playerId };
}

/** Sobe N processos bun separados e junta o resultado de cada um. */
async function runInstances(
  mode: 'distinct' | 'same',
  w: { id: string; playerId: string },
  providerId: string,
  instances: number,
  perInstance: number,
): Promise<Record<string, number>[]> {
  const procs = Array.from({ length: instances }, (_, n) =>
    Bun.spawn(
      ['bun', 'run', RUNNER, mode, w.id, w.playerId, providerId, String(n), String(perInstance)],
      { stdout: 'pipe', stderr: 'pipe', env: process.env },
    ),
  );
  return Promise.all(
    procs.map(async (p) => {
      const [out, err] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      await p.exited;
      if (!out.trim()) throw new Error(`instância sem saída: ${err}`);
      return JSON.parse(out.trim().split('\n').at(-1)!) as Record<string, number>;
    }),
  );
}

async function one(sql: string, params: unknown[]) {
  const [row] = (await orm.em.execute(sql, params)) as unknown as Record<string, any>[];
  return row!;
}

describe('3 instâncias (processos separados) sobre a mesma wallet', () => {
  test('60 apostas diferentes de 10.00 sobre saldo 100.00: exatamente 10 passam, saldo 0.00', async () => {
    const w = await createWallet('10000');
    const provider = `provider-multi-${crypto.randomUUID().slice(0, 8)}`;
    const results = await runInstances('distinct', w, provider, 3, 20);

    const total: Record<string, number> = {};
    for (const r of results) for (const [k, v] of Object.entries(r)) total[k] = (total[k] ?? 0) + v;
    expect(total['PROCESSED']).toBe(10);
    expect(total['REJECTED']).toBe(50);
    expect(Object.keys(total).filter((k) => k.startsWith('ERRO'))).toEqual([]);

    const wallet = await one(`SELECT balance_cents::text AS v FROM wallet WHERE id = ?::uuid`, [w.id]);
    expect(wallet.v).toBe('0');
    const ledger = await one(
      `SELECT count(*)::int AS n,
              COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_cents ELSE -amount_cents END), 0)::text AS net
       FROM wallet_ledger_entry WHERE wallet_id = ?::uuid`,
      [w.id],
    );
    expect(ledger.n).toBe(10);
    // Invariante final: saldo inicial (10000) + ledger == saldo da wallet.
    expect(BigInt(10000) + BigInt(ledger.net)).toBe(BigInt(wallet.v));
  }, 60_000);

  test('a mesma aposta enviada por 3 instâncias (60 envios): um único débito', async () => {
    const w = await createWallet('10000');
    const provider = `provider-same-${crypto.randomUUID().slice(0, 8)}`;
    const results = await runInstances('same', w, provider, 3, 20);

    const total: Record<string, number> = {};
    for (const r of results) for (const [k, v] of Object.entries(r)) total[k] = (total[k] ?? 0) + v;
    expect(total['PROCESSED']).toBe(1);
    expect(total['PROCESSED:replay']).toBe(59);

    const wallet = await one(`SELECT balance_cents::text AS v FROM wallet WHERE id = ?::uuid`, [w.id]);
    expect(wallet.v).toBe('9000');
    const ledger = await one(
      `SELECT count(*)::int AS n FROM wallet_ledger_entry WHERE wallet_id = ?::uuid`,
      [w.id],
    );
    expect(ledger.n).toBe(1);
  }, 60_000);
});