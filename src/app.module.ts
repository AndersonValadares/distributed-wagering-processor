import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { AuthGuard } from './auth/auth.guard.ts';
import { HealthController } from './health/health.controller.ts';
import { DomainExceptionFilter } from './http/domain-exception.filter.ts';
import { MetricsController } from './observability/metrics.controller.ts';
import { SubmitTransactionUseCase } from './wagering/submit-transaction.ts';
import { TransactionsController } from './wagering/transactions.controller.ts';
import { CreateWalletUseCase } from './wallet/create-wallet.ts';
import { QueriesController } from './wallet/queries.controller.ts';
import { WalletsController } from './wallet/wallets.controller.ts';

@Module({
  controllers: [
    HealthController,
    WalletsController,
    TransactionsController,
    QueriesController,
    MetricsController,
  ],
  providers: [
    {
      provide: MikroORM,
      useFactory: () =>
        MikroORM.init({
          clientUrl: process.env.DATABASE_URL,
          entities: [],
          discovery: { warnWhenNoEntities: false },
        }),
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    CreateWalletUseCase,
    SubmitTransactionUseCase,
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}