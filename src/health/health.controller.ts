import { Controller, Get, Res } from '@nestjs/common';
import { ListQueuesCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { createSqsClient } from '../messaging/sqs.ts';

type Check = 'up' | 'down';
type ResponseLike = { status(code: number): unknown };

@Controller('health')
export class HealthController {
  private readonly sqs = createSqsClient();

  constructor(private readonly orm: MikroORM) {}

  /** Liveness: o processo está vivo. Não toca em nenhuma dependência. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS respondem? Qualquer um fora do ar devolve 503 com o detalhe. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: ResponseLike) {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const checks = { postgres, sqs };
    if (postgres === 'up' && sqs === 'up') return { status: 'ok', checks };
    res.status(503);
    return { status: 'unavailable', checks };
  }

  private async checkPostgres(): Promise<Check> {
    try {
      await this.orm.em.fork().execute('select 1');
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkSqs(): Promise<Check> {
    try {
      // Timeout de 2s: readiness não pode ficar pendurado esperando o SQS.
      await this.sqs.send(new ListQueuesCommand({ MaxResults: 1 }), {
        abortSignal: AbortSignal.timeout(2000),
      });
      return 'up';
    } catch {
      return 'down';
    }
  }
}