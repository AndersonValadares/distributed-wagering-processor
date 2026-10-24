import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from './app.module.ts';
import { OutboxPublisher } from './messaging/outbox-publisher.ts';
import { createSqsClient, ensureQueues } from './messaging/sqs.ts';
import { WagerConsumer } from './messaging/wager-consumer.ts';
import { SubmitTransactionUseCase } from './wagering/submit-transaction.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = await NestFactory.create(AppModule);
const sqs = createSqsClient();
const queues = await ensureQueues(sqs);

const consumer = new WagerConsumer(app.get(SubmitTransactionUseCase), sqs, queues.main);
consumer.start();

const publisher = new OutboxPublisher(app.get(MikroORM), sqs, queues.events);
let publishing = true;
const publisherLoop = (async () => {
  while (publishing) {
    try {
      const r = await publisher.runOnce();
      if (r.published + r.failed === 0) await sleep(1000);
    } catch {
      await sleep(2000);
    }
  }
})();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await consumer.stop(); // conclui a mensagem em andamento
  publishing = false;
  await publisherLoop;
  await app.close(); // fecha HTTP e banco
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen(Number(process.env.PORT ?? 3000));
console.log(`Servidor no ar: http://localhost:${process.env.PORT ?? 3000}`);