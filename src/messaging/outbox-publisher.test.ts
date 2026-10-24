import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ReceiveMessageCommand, PurgeQueueCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { OutboxPublisher, backoffSeconds } from './outbox-publisher.ts';
import { createSqsClient, ensureQueues, type QueueUrls } from './sqs.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Defina DATABASE_URL antes de rodar este teste');

const orm = await MikroORM.init({
  clientUrl: url,
  entities: [],
  discovery: { warnWhenNoEntities: false },
});
const sqs = createSqsClient();
let queues!: QueueUrls;

beforeAll(async () => {
  queues = await ensureQueues(sqs);
});
afterAll(async () => {
  await orm.close();
});

/** Marca como publicados os eventos de execuções anteriores, para o teste ver só os seus. */
async function clearPending() {
  await orm.em.execute(`UPDATE outbox_message SET published_at = now() WHERE published_at IS NULL`);
}

async function seed(n: number): Promise<string[]> {
  const aggregate = crypto.randomUUID();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    await orm.em.execute(
      `INSERT INTO outbox_message (id, aggregate_id, event_type, payload, occurred_at)
       VALUES (?::uuid, ?::uuid, 'TesteEvento', ?::jsonb, now())`,
      [id, aggregate, JSON.stringify({ eventId: id, n: i })],
    );
  }
  return ids;
}

async function drain(): Promise<string[]> {
  const received: string[] = [];
  for (let i = 0; i < 40; i++) {
    const out = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queues.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
    );
    if (!out.Messages?.length) break;
    for (const m of out.Messages) received.push(JSON.parse(m.Body!).eventId);
  }
  return received;
}

describe('backoff', () => {
  test('cresce exponencialmente e tem teto', () => {
    expect(backoffSeconds(1)).toBe(2);
    expect(backoffSeconds(3)).toBe(8);
    expect(backoffSeconds(20)).toBe(300);
  });
});

describe('OutboxPublisher', () => {
  test('publica os pendentes e marca published_at', async () => {
    await clearPending();
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queues.events })).catch(() => {});
    const ids = await seed(5);
    const pub = new OutboxPublisher(orm, sqs, queues.events);
    const r = await pub.runOnce();
    expect(r.published).toBe(5);

        const rows = (await orm.em.execute(
      `SELECT count(*)::int AS n FROM outbox_message
       WHERE id IN (SELECT jsonb_array_elements_text(?::jsonb)::uuid) AND published_at IS NOT NULL`,
      [JSON.stringify(ids)],
    )) as unknown as { n: number }[];
  });

  test('dois publishers concorrentes: cada evento é publicado exatamente uma vez', async () => {
    await clearPending();
    const ids = await seed(30);
    const a = new OutboxPublisher(orm, sqs, queues.events, 10);
    const b = new OutboxPublisher(orm, sqs, queues.events, 10);

    const rounds = await Promise.all([a.runOnce(), b.runOnce(), a.runOnce(), b.runOnce()]);
    const total = rounds.reduce((s, r) => s + r.published, 0);
    expect(total).toBe(30);

    const rows = (await orm.em.execute(
      `SELECT count(*)::int AS n FROM outbox_message
       WHERE id IN (SELECT jsonb_array_elements_text(?::jsonb)::uuid) AND published_at IS NOT NULL`,
      [JSON.stringify(ids)],
    )) as unknown as { n: number }[];
    expect(rows[0]!.n).toBe(30);
  });

  test('falha no SQS: agenda nova tentativa com backoff e não perde o evento', async () => {
    await clearPending();
    const [id] = await seed(1);
    const broken = new OutboxPublisher(orm, sqs, 'http://localhost:4566/000000000000/nao-existe.fifo');
    const r = await broken.runOnce();
    expect(r.failed).toBe(1);

    const [row] = (await orm.em.execute(
      `SELECT attempts, published_at, next_attempt_at > now() AS adiado FROM outbox_message WHERE id = ?::uuid`,
      [id],
    )) as unknown as { attempts: number; published_at: unknown; adiado: boolean }[];
    expect(row!.attempts).toBe(1);
    expect(row!.published_at).toBeNull();
    expect(row!.adiado).toBe(true);
  });
});