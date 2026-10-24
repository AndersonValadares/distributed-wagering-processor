import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from './app.module.ts';
import { OutboxPublisher } from './messaging/outbox-publisher.ts';
import { PendingReferenceWorker } from './messaging/pending-reference-worker.ts';
import { createSqsClient, ensureQueues } from './messaging/sqs.ts';
import { WagerConsumer } from './messaging/wager-consumer.ts';
import { SubmitTransactionUseCase } from './wagering/submit-transaction.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = await NestFactory.create(AppModule);
const orm = app.get(MikroORM) as unknown as ConstructorParameters<typeof OutboxPublisher>[0];
const sqs = createSqsClient();
const queues = await ensureQueues(sqs);

const consumer = new WagerConsumer(app.get(SubmitTransactionUseCase), sqs, queues.main);
consumer.start();

// Loops de fundo: publisher da outbox e worker de PENDING_REFERENCE.
let running = true;
function background(work: () => Promise<number>, idleMs: number): Promise<void> {
  return (async () => {
    while (running) {
      try {
        if ((await work()) === 0) await sleep(idleMs);
      } catch {
        await sleep(2000);
      }
    }
  })();
}
const publisher = new OutboxPublisher(orm, sqs, queues.events);
const referenceWorker = new PendingReferenceWorker(orm);
const loops = [
  background(async () => {
    const r = await publisher.runOnce();
    return r.published + r.failed;
  }, 1000),
  background(async () => {
    const r = await referenceWorker.runOnce();
    return r.processed + r.rejected + r.waiting + r.failed;
  }, 2000),
];

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await consumer.stop(); // conclui a mensagem em andamento
  running = false;
  await Promise.all(loops);
  await app.close(); // fecha HTTP e banco
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen(Number(process.env.PORT ?? 3000));
console.log(`Servidor no ar: http://localhost:${process.env.PORT ?? 3000}`);