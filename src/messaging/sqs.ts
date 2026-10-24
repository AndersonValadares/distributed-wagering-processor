import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export const QUEUE_NAME = 'wager-transactions.fifo';
export const DLQ_NAME = 'wager-transactions-dlq.fifo';
export const EVENTS_QUEUE_NAME = 'wager-events.fifo';
export const MAX_RECEIVE_COUNT = 5;

export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

async function createFifo(
  sqs: SQSClient,
  name: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const out = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...extra },
    }),
  );
  return out.QueueUrl!;
}

export type QueueUrls = { main: string; dlq: string; events: string };

/** Idempotente: pode rodar várias vezes. Cria DLQ, fila principal (com redrive) e fila de eventos. */
export async function ensureQueues(sqs: SQSClient): Promise<QueueUrls> {
  const dlq = await createFifo(sqs, DLQ_NAME);
  const attrs = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = attrs.Attributes!.QueueArn!;
  const main = await createFifo(sqs, QUEUE_NAME, {
    VisibilityTimeout: '30',
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: String(MAX_RECEIVE_COUNT),
    }),
  });
  const events = await createFifo(sqs, EVENTS_QUEUE_NAME);
  return { main, dlq, events };
}