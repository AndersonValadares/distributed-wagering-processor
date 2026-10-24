import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PurgeQueueCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { SubmitTransactionUseCase } from '../wagering/submit-transaction.ts';
import { createSqsClient, ensureQueues, type QueueUrls } from './sqs.ts';
import { CONSUMER_NAME, WagerConsumer, parseMessage } from './wager-consumer.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Defina DATABASE_URL antes de rodar este teste');

const orm = await MikroORM.init({
  clientUrl: url,
  entities: [],
  discovery: { warnWhenNoEntities: false },
});
const sqs = createSqsClient();
const useCase = new SubmitTransactionUseCase(orm);
const PROVIDER = `provider-sqs-${crypto.randomUUID().slice(0, 8)}`;
let queues!: QueueUrls;
let consumer!: WagerConsumer;

beforeAll(async () => {
  queues = await ensureQueues(sqs);
  await sqs.send(new PurgeQueueCommand({ QueueUrl: queues.main })).catch(() => {});
  consumer = new WagerConsumer(useCase, sqs, queues.main);
});
afterAll(async () => {
  await orm.close();
});

async function createWallet(balance = '10000') {
  const id = crypto.randomUUID();
  const playerId = crypto.randomUUID();
  await orm.em.execute(
    `INSERT INTO wallet (id, player_id, currency, balance_cents) VALUES (?::uuid, ?::uuid, 'BRL', ?::bigint)`,
    [id, playerId, balance],
  );
  return { id, playerId };
}
type W = Awaited<ReturnType<typeof createWallet>>;

function data(w: W, ext: string, amount = '25.00', kind = 'BET') {
  return {
    providerId: PROVIDER,
    externalTransactionId: ext,
    idempotencyKey: `${PROVIDER}:${ext}`,
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

function body(messageId: string, payload: unknown) {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: payload,
  });
}

function send(messageBody: string, group: string) {
  return sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.main,
      MessageBody: messageBody,
      MessageGroupId: group,
      MessageDeduplicationId: crypto.randomUUID(), // permite reenviar o mesmo messageId
    }),
  );
}

async function pollAll(max = 6) {
  for (let i = 0; i < max; i++) {
    if ((await consumer.pollOnce(1)) === 0) break;
  }
}

async function one(sql: string, params: unknown[]) {
  const [row] = (await orm.em.execute(sql, params)) as unknown as Record<string, any>[];
  return row!;
}
const balance = async (w: W) =>
  (await one(`SELECT balance_cents::text AS v FROM wallet WHERE id = ?::uuid`, [w.id])).v;
const ledger = async (w: W) =>
  (await one(`SELECT count(*)::int AS v FROM wallet_ledger_entry WHERE wallet_id = ?::uuid`, [w.id])).v;

describe('WagerConsumer', () => {
  test('processa a mensagem, grava o inbox e apaga da fila', async () => {
    const w = await createWallet();
    const messageId = `msg-${crypto.randomUUID()}`;
    await send(body(messageId, data(w, 'sqs-1')), w.id);
    await pollAll();

    expect(await balance(w)).toBe('7500');
    expect(await ledger(w)).toBe(1);
    const inbox = await one(
      `SELECT count(*)::int AS v FROM inbox_message WHERE consumer_name = ? AND message_id = ?`,
      [CONSUMER_NAME, messageId],
    );
    expect(inbox.v).toBe(1);
  });

  test('redelivery da mesma mensagem não duplica o efeito', async () => {
    const w = await createWallet();
    const messageId = `msg-${crypto.randomUUID()}`;
    const payload = body(messageId, data(w, 'sqs-2'));
    await send(payload, w.id);
    await send(payload, w.id); // mesma mensagem entregue de novo
    await send(body(`msg-${crypto.randomUUID()}`, data(w, 'sqs-2')), w.id); // outro messageId, mesma operação
    await pollAll();

    expect(await balance(w)).toBe('7500');
    expect(await ledger(w)).toBe(1);
  });

  test('worker morto depois do commit e antes do ack: a reentrega é ignorada', async () => {
    const w = await createWallet();
    const messageId = `msg-${crypto.randomUUID()}`;
    const payload = body(messageId, data(w, 'sqs-3'));
    await send(payload, w.id);

    // Simula o worker: processa e comita, mas morre antes de apagar a mensagem.
    const parsed = parseMessage(payload);
    await useCase.executeFromMessage(parsed.input, { consumerName: CONSUMER_NAME, messageId });
    expect(await balance(w)).toBe('7500');

    // Outro worker recebe a mensagem de novo.
    await pollAll();
    expect(await balance(w)).toBe('7500');
    expect(await ledger(w)).toBe(1);
  });

  test('rejeição de negócio (sem saldo) é processada e confirmada, sem retry', async () => {
    const w = await createWallet('1000'); // 10.00
    await send(body(`msg-${crypto.randomUUID()}`, data(w, 'sqs-4', '80.00')), w.id);
    await pollAll();

    const tx = await one(
      `SELECT status, failure_code FROM wager_transaction WHERE provider_id = ? AND external_transaction_id = 'sqs-4'`,
      [PROVIDER],
    );
    expect(tx.status).toBe('REJECTED');
    expect(tx.failure_code).toBe('INSUFFICIENT_FUNDS');
    expect(await balance(w)).toBe('1000');
  });

  test('mensagem inválida vai para a DLQ depois de 5 recebimentos', async () => {
    const messageId = `poison-${crypto.randomUUID()}`;
    await send(body(messageId, { kind: 'BET' }), `grupo-${messageId}`);
    for (let i = 0; i < 6; i++) {
      await consumer.pollOnce(1);
      await new Promise((r) => setTimeout(r, 300));
    }

    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      const out = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queues.dlq, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
      );
      found = (out.Messages ?? []).some((m) => m.Body?.includes(messageId));
    }
    expect(found).toBe(true);
  });
});