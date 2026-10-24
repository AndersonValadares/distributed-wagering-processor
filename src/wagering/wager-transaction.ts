import { Money } from '../shared/money.ts';
import type { FailureCode } from './failure-code.ts';

export const WagerTransactionKind = {
  Opening: 'OPENING',
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;
export type WagerTransactionKind =
  (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

export const WagerTransactionStatus = {
  Pending: 'PENDING',
  PendingReference: 'PENDING_REFERENCE',
  Processed: 'PROCESSED',
  Rejected: 'REJECTED',
  Failed: 'FAILED',
} as const;
export type WagerTransactionStatus =
  (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

export const LedgerDirection = { Debit: 'DEBIT', Credit: 'CREDIT' } as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];

export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}

export class WagerTransactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WagerTransactionValidationError';
  }
}

export type WagerTransactionState = {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  createdAt: Date;
};

export type CreateWagerTransactionProps = Omit<
  WagerTransactionState,
  'status' | 'referenceTransactionId' | 'failureCode' | 'processedAt'
>;

export class WagerTransaction {
  private constructor(private readonly state: WagerTransactionState) {}

  /** Nasce em PENDING. Valida as regras de entrada. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new WagerTransactionValidationError('OPENING é interno e não pode ser submetido');
    }
    const needsReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;
    if (needsReference && !props.referenceExternalTransactionId) {
      throw new WagerTransactionValidationError(
        `${props.kind} exige referenceExternalTransactionId`,
      );
    }
    if (props.kind !== WagerTransactionKind.Loss && props.money.isZero()) {
      throw new WagerTransactionValidationError(`${props.kind} exige valor maior que zero`);
    }
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
    });
  }

  /** Reconstrói a partir do banco. Não revalida nada: o estado já foi aceito antes. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({ ...state });
  }

  get id() { return this.state.id; }
  get providerId() { return this.state.providerId; }
  get externalTransactionId() { return this.state.externalTransactionId; }
  get idempotencyKey() { return this.state.idempotencyKey; }
  get payloadHash() { return this.state.payloadHash; }
  get walletId() { return this.state.walletId; }
  get playerId() { return this.state.playerId; }
  get roundId() { return this.state.roundId; }
  get gameId() { return this.state.gameId; }
  get kind() { return this.state.kind; }
  get money() { return this.state.money; }
  get referenceExternalTransactionId() { return this.state.referenceExternalTransactionId; }
  get status() { return this.state.status; }
  get referenceTransactionId() { return this.state.referenceTransactionId; }
  get failureCode() { return this.state.failureCode; }
  get processedAt() { return this.state.processedAt; }
  get createdAt() { return this.state.createdAt; }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this.state.status = WagerTransactionStatus.Processed;
    this.state.referenceTransactionId = referenceTransactionId;
    this.state.processedAt = at;
  }

  markPendingReference(): void {
    if (this.state.status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        `markPendingReference só vale a partir de PENDING (atual: ${this.state.status})`,
      );
    }
    this.state.status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal('reject');
    this.state.status = WagerTransactionStatus.Rejected;
    this.state.failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this.state.status = WagerTransactionStatus.Failed;
    this.state.failureCode = code;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return (
      this.state.status === WagerTransactionStatus.Processed ||
      this.state.status === WagerTransactionStatus.Rejected ||
      this.state.status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.state.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.state.kind === WagerTransactionKind.Refund ||
      this.state.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.state.payloadHash === payloadHash;
  }

  /** Débito ou crédito? ROLLBACK é o inverso da transação que ele reverte. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.state.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new WagerTransactionValidationError('ROLLBACK precisa da referência');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      default:
        throw new WagerTransactionValidationError(`${this.state.kind} não gera lançamento`);
    }
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `${action} inválido: transação já está em estado terminal (${this.state.status})`,
      );
    }
  }
}
