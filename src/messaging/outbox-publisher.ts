import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

type Row = Record<string, any>;

export type PublishResult = { published: number; failed: number };

export const MAX_BACKOFF_SECONDS = 300;

/** Backoff exponencial: 2s, 4s, 8s... com teto de 5 minutos. */
export function backoffSeconds(attempts: number): number {
  return Math.min(2 ** attempts, MAX_BACKOFF_SECONDS);
}

export class OutboxPublisher {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly batchSize = 20,
  ) {}

  /**
   * Um ciclo. FOR UPDATE SKIP LOCKED: dois publishers nunca pegam o mesmo evento ao mesmo tempo.
   * Se o processo morrer antes do commit, o lock some e o evento fica pendente de novo:
   * será publicado outra vez (at-least-once). O consumidor deduplica pelo eventId.
   */
  async runOnce(): Promise<PublishResult> {
    const result: PublishResult = { published: 0, failed: 0 };
    await this.orm.em.fork().transactional(async (em) => {
      const rows = (await em.execute(
        `SELECT id::text AS id, aggregate_id::text AS aggregate_id, payload, attempts
         FROM outbox_message
         WHERE published_at IS NULL AND next_attempt_at <= now()
         ORDER BY occurred_at
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      )) as unknown as Row[];

      for (const row of rows) {
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: this.queueUrl,
              MessageBody:
                typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload),
              // Eventos da mesma wallet saem em ordem; o dedup id torna o reenvio inofensivo.
              MessageGroupId: row.aggregate_id,
              MessageDeduplicationId: row.id,
            }),
          );
          await em.execute(`UPDATE outbox_message SET published_at = now() WHERE id = ?::uuid`, [row.id]);
          result.published++;
        } catch {
          const attempts = Number(row.attempts) + 1;
          await em.execute(
            `UPDATE outbox_message
             SET attempts = ?, next_attempt_at = now() + (? * interval '1 second')
             WHERE id = ?::uuid`,
            [attempts, backoffSeconds(attempts), row.id],
          );
          result.failed++;
        }
      }
    });
    return result;
  }
}