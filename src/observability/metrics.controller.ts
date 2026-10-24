import { Controller, Get, Header } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { renderProcessMetrics } from './metrics.ts';

type Row = Record<string, any>;

@Controller('metrics')
export class MetricsController {
  constructor(private readonly orm: MikroORM) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4')
  async metrics(): Promise<string> {
    const em = this.orm.em.fork();
    const rows = async (sql: string) => (await em.execute(sql)) as unknown as Row[];

    const byStatus = await rows(
      `SELECT status, count(*)::int AS n FROM wager_transaction GROUP BY status`,
    );
    const [outbox] = await rows(
      `SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS pending,
              COALESCE(EXTRACT(EPOCH FROM (now() - min(occurred_at)
                FILTER (WHERE published_at IS NULL))), 0)::float8 AS lag_seconds,
              COALESCE(sum(attempts) FILTER (WHERE published_at IS NULL), 0)::int AS retries
       FROM outbox_message`,
    );
    const [pendingRef] = await rows(
      `SELECT count(*)::int AS n FROM wager_transaction WHERE status = 'PENDING_REFERENCE'`,
    );
    const [inbox] = await rows(`SELECT count(*)::int AS n FROM inbox_message`);

    const lines: string[] = [
      '# TYPE wager_transactions gauge',
      ...byStatus.map((r) => `wager_transactions{status="${r.status}"} ${r.n}`),
      '# TYPE wager_outbox_pending gauge',
      `wager_outbox_pending ${outbox?.pending ?? 0}`,
      '# TYPE wager_outbox_lag_seconds gauge',
      `wager_outbox_lag_seconds ${outbox?.lag_seconds ?? 0}`,
      '# TYPE wager_outbox_publish_retries gauge',
      `wager_outbox_publish_retries ${outbox?.retries ?? 0}`,
      '# TYPE wager_pending_reference gauge',
      `wager_pending_reference ${pendingRef?.n ?? 0}`,
      '# TYPE wager_inbox_messages gauge',
      `wager_inbox_messages ${inbox?.n ?? 0}`,
      '# TYPE wager_process_counters counter',
      renderProcessMetrics(),
    ];
    return lines.join('\n') + '\n';
  }
}