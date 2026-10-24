import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';

@Controller('health')
export class HealthController {
  constructor(private readonly orm: MikroORM) {}

  /** Liveness: o processo está vivo. Não toca em nenhuma dependência. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: o Postgres responde? (O SQS entra quando o consumer existir.) */
  @Get('ready')
  async ready() {
    try {
      await this.orm.em.execute('select 1');
      return { status: 'ok', checks: { postgres: 'up' } };
    } catch {
      throw new HttpException(
        { status: 'unavailable', checks: { postgres: 'down' } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}