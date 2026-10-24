import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { asMoney, asObject, asString, asUuid, ValidationError } from '../http/parsers.ts';
import { MoneyError } from '../shared/money.ts';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
  type SubmitInput,
  type SubmitTransactionUseCase,
} from '../wagering/submit-transaction.ts';
import { WagerTransactionKind, WagerTransactionValidationError } from '../wagering/wager-transaction.ts';

export const CONSUMER_NAME = 'wager-transactions-consumer';

const SUBMITTABLE = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/** Erros que nunca vão melhorar com retry: a mensagem segue para a DLQ após maxReceiveCount. */
const PERMANENT: Array<new (...args: any[]) => Error> = [
  SyntaxError,
  ValidationError,
  MoneyError,
  WagerTransactionValidationError,
  IdempotencyConflictError,
  WalletNotFoundError,
];

export function parseMessage(body: string): { messageId: string; input: SubmitInput } {
  const root = asObject(JSON.parse(body), 'message');
  const messageId = asString(root, 'messageId');
  if (asString(root, 'type') !== 'WagerTransactionRequested') {
    throw new ValidationError('type deve ser WagerTransactionRequested');
  }
  const data = asObject(root['data'], 'data');
  const kind = asString(data, 'kind');
  if (!SUBMITTABLE.has(kind)) throw new ValidationError(`kind inválido: ${kind}`);
  const ref = data['referenceExternalTransactionId'];
  return {
    messageId,
    input: {
      providerId: asString(data, 'providerId'),
      externalTransactionId: asString(data, 'externalTransactionId'),
      idempotencyKey: asString(data, 'idempotencyKey'),
      playerId: asUuid(data, 'playerId'),
      walletId: asUuid(data, 'walletId'),
      roundId: asString(data, 'roundId'),
      gameId: asString(data, 'gameId'),
      kind: kind as WagerTransactionKind,
      money: asMoney(data, 'money'),
      referenceExternalTransactionId:
        ref === undefined || ref === null ? undefined : asString(data, 'referenceExternalTransactionId'),
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WagerConsumer {
  private stopping = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly useCase: SubmitTransactionUseCase,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  start(): void {
    this.loop = this.run();
  }

  /** SIGTERM: termina a mensagem em andamento e devolve as não iniciadas à fila. */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce(5);
      } catch (error) {
        this.log('poll_failed', { error: (error as Error).name });
        await sleep(2000);
      }
    }
  }

  async pollOnce(waitSeconds = 1): Promise<number> {
    const out = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    let handled = 0;
    for (const message of out.Messages ?? []) {
      if (this.stopping) {
        await this.setVisibility(message, 0); // não começou: devolve na hora
        continue;
      }
      await this.handle(message);
      handled++;
    }
    return handled;
  }

  private async handle(message: Message): Promise<void> {
    try {
      const { messageId, input } = parseMessage(message.Body ?? '');
      await this.useCase.executeFromMessage(input, { consumerName: CONSUMER_NAME, messageId });
      // Ack SOMENTE depois do commit. REJECTED e PENDING_REFERENCE também são "processado".
      // undefined = duplicata (inbox): também é ack.
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle! }),
      );
    } catch (error) {
      const permanent = PERMANENT.some((type) => error instanceof type);
      const received = Number(message.Attributes?.['ApproximateReceiveCount'] ?? 1);
      this.log(permanent ? 'permanent_error' : 'transient_error', {
        messageId: message.MessageId,
        error: (error as Error).name,
        received,
      });
      // Permanente: reentrega imediata para o SQS contar as tentativas e mover para a DLQ.
      // Transitório: backoff exponencial (até 60s) antes de tentar de novo.
      await this.setVisibility(message, permanent ? 0 : Math.min(2 ** received, 60));
    }
  }

  private async setVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle!,
          VisibilityTimeout: seconds,
        }),
      );
    } catch {
      /* se falhar, o VisibilityTimeout da fila devolve a mensagem de qualquer forma */
    }
  }

  /** Log estruturado em JSON. Nunca inclui o corpo da mensagem (dados financeiros). */
  private log(event: string, fields: Record<string, unknown>): void {
    console.log(JSON.stringify({ level: 'warn', event, consumer: CONSUMER_NAME, ...fields }));
  }
}