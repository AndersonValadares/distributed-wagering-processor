import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import { asMoney, asObject, asString, asUuid, ValidationError } from '../http/parsers.ts';
import { providerActionFor } from './failure-code.ts';
import { SubmitTransactionUseCase } from './submit-transaction.ts';
import { WagerTransactionKind } from './wager-transaction.ts';

type ResponseLike = { status(code: number): unknown };

const SUBMITTABLE = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

function optionalString(obj: Record<string, unknown>, field: string): string | undefined {
  if (obj[field] === undefined || obj[field] === null) return undefined;
  return asString(obj, field);
}

@Controller('wagering/transactions')
export class TransactionsController {
  constructor(private readonly submit: SubmitTransactionUseCase) {}

  @Post()
  @HttpCode(200)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: ResponseLike,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new ValidationError('header Idempotency-Key é obrigatório');
    }
    const obj = asObject(body, 'body');
    const kind = asString(obj, 'kind');
    if (!SUBMITTABLE.has(kind)) {
      throw new ValidationError(`kind inválido: ${kind}`);
    }

    const result = await this.submit.execute({
      providerId: asString(obj, 'providerId'),
      externalTransactionId: asString(obj, 'externalTransactionId'),
      idempotencyKey: idempotencyKey.trim(),
      playerId: asUuid(obj, 'playerId'),
      walletId: asUuid(obj, 'walletId'),
      roundId: asString(obj, 'roundId'),
      gameId: asString(obj, 'gameId'),
      kind: kind as WagerTransactionKind,
      money: asMoney(obj, 'money'),
      referenceExternalTransactionId: optionalString(obj, 'referenceExternalTransactionId'),
    });

    if (result.status === 'REJECTED') res.status(422);
    else if (result.status === 'PENDING_REFERENCE') res.status(202);

    return {
      transactionId: result.transactionId,
      status: result.status,
      ...(result.failureCode
        ? { failureCode: result.failureCode, providerAction: providerActionFor(result.failureCode) }
        : {}),
      balance: { amount: result.balance.toDecimal(), currency: result.balance.currency },
      idempotentReplay: result.idempotentReplay,
    };
  }
}