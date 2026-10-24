import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module.ts';

let app!: INestApplication;
let base = '';

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(async () => {
  await app.close();
});

describe('health', () => {
  test('live e ready: 200, com postgres e sqs "up"', async () => {
    expect((await fetch(base + '/health/live')).status).toBe(200);
    const res = await fetch(base + '/health/ready');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).checks).toEqual({ postgres: 'up', sqs: 'up' });
  });
});