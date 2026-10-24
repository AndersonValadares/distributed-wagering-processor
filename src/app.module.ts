import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { HealthController } from './health/health.controller.ts';

@Module({
  controllers: [HealthController],
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
  ],
})
export class AppModule {}