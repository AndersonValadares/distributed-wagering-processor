import { NotFoundError } from '../wallet/queries.controller.ts';
import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { MoneyError } from '../shared/money.ts';
import { IdempotencyConflictError, WalletNotFoundError } from '../wagering/submit-transaction.ts';
import { WagerTransactionValidationError } from '../wagering/wager-transaction.ts';
import { WalletAlreadyExistsError } from '../wallet/create-wallet.ts';
import { ValidationError } from './parsers.ts';

type Res = {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
};

type Translated = { status: number; code: string; message: string; retryAfter?: number };

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  '57P01', '57P03', // banco desligando / ainda subindo
  '40001', '40P01', // falha de serialização / deadlock: vale tentar de novo
  '53300', // conexões demais
  '08000', '08001', '08006', // falha de conexão
]);

function isTransient(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === 'string' && TRANSIENT_CODES.has(e.code)) return true;
  return (
    typeof e?.message === 'string' &&
    /timeout acquiring a connection|connection terminated|connection closed|ECONNREFUSED/i.test(
      e.message,
    )
  );
}

/**
 * Tabela única de erro -> status HTTP, igual para todos os endpoints:
 *   400 payload inválido | 404 não existe | 409 conflito
 *   503 falha transitória (reenviar depois) | 500 bug nosso
 * (422 e 202 são respostas de sucesso do fluxo, e não erros: entram no controller de transações.)
 */
function translate(error: unknown): Translated {
  if (
    error instanceof ValidationError ||
    error instanceof MoneyError ||
    error instanceof WagerTransactionValidationError
  ) {
    return {
      status: 400,
      code: error instanceof WagerTransactionValidationError ? 'INVALID_TRANSACTION' : error.code,
      message: error.message,
    };
  }
  if (error instanceof WalletNotFoundError || error instanceof NotFoundError) {
    return { status: 404, code: error.code, message: error.message };
  }
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) {
    return { status: 409, code: error.code, message: error.message };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      status,
      code: status === 400 ? 'INVALID_REQUEST' : 'HTTP_ERROR',
      message: error.message,
    };
  }
  if (isTransient(error)) {
    return {
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'falha temporária de infraestrutura, tente novamente',
      retryAfter: 2,
    };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'erro interno' };
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Res>();
    const result = translate(error);
    if (result.status >= 500) {
      // Só nome e mensagem: nunca o corpo da requisição (pode ter dados financeiros).
      const e = error as { name?: string; message?: string };
      this.logger.error(`${result.code}: ${e?.name} - ${e?.message}`);
    }
    if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter));
    res.status(result.status).json({ error: { code: result.code, message: result.message } });
  }
}