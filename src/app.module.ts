import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { SubmitTransactionUseCase } from './wagering/submit-transaction.ts';
import { TransactionsController } from './wagering/transactions.controller.ts';
import { APP_FILTER } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { HealthController } from './health/health.controller.ts';
import { DomainExceptionFilter } from './http/domain-exception.filter.ts';
import { CreateWalletUseCase } from './wallet/create-wallet.ts';
import { WalletsController } from './wallet/wallets.controller.ts';

@Module({
  controllers: [HealthController, WalletsController, TransactionsController],
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