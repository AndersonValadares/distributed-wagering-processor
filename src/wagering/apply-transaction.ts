import { Wallet, WalletError } from '../wallet/wallet.ts';
import type { FailureCode } from './failure-code.ts';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  LedgerDirection,
} from './wager-transaction.ts';
import type { WalletLedgerEntry } from './wallet-ledger-entry.ts';

export type ApplyInput = {
  transaction: WagerTransaction;
  wallet: Wallet;
  /** A transação referenciada, já buscada no banco. undefined = ainda não chegou. */
  reference: WagerTransaction | undefined;
  /** Já existe um REFUND/ROLLBACK PROCESSED apontando para a referência? */
  referenceAlreadyReversed: boolean;
  entryId: string;
  now: Date;
};

export type ApplyOutcome =
  | { type: 'PROCESSED'; wallet: Wallet; entry: WalletLedgerEntry | undefined }
  | { type: 'REJECTED'; code: FailureCode }
  | { type: 'PENDING_REFERENCE' };

/** Quais tipos cada reversão pode referenciar. */
const ALLOWED_REFERENCES: Record<string, string[]> = {
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};

function reject(tx: WagerTransaction, code: FailureCode): ApplyOutcome {
  tx.reject(code);
  return { type: 'REJECTED', code };
}

/**
 * Decide o que acontece com a transação e atualiza o estado dela.
 * Não toca no banco: quem chama é responsável por gravar o resultado.
 */
export function applyTransaction(input: ApplyInput): ApplyOutcome {
  const { transaction: tx, wallet, now } = input;

  if (tx.money.currency !== wallet.currency) {
    return reject(tx, 'CURRENCY_MISMATCH');
  }
  if (tx.requiresReference()) {
    return applyReversal(input);
  }
  if (!tx.affectsBalance()) {
    // LOSS: registra o resultado sem mexer no saldo.
    tx.markProcessed(undefined, now);
    return { type: 'PROCESSED', wallet, entry: undefined };
  }
  return applyMovement(input, undefined);
}

function applyReversal(input: ApplyInput): ApplyOutcome {
  const { transaction: tx, wallet, reference } = input;

  if (!reference) return waitForReference(tx);

  const sameContext =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === wallet.id &&
    reference.money.currency === tx.money.currency &&
    reference.roundId === tx.roundId;
  if (!sameContext) return reject(tx, 'REFERENCE_MISMATCH');

  if (!ALLOWED_REFERENCES[tx.kind]?.includes(reference.kind)) {
    return reject(tx, 'INVALID_REFERENCE_KIND');
  }

  if (reference.status === Status.Pending || reference.status === Status.PendingReference) {
    return waitForReference(tx);
  }
  if (reference.status !== Status.Processed) {
    return reject(tx, 'REFERENCE_NOT_PROCESSED');
  }

  if (input.referenceAlreadyReversed) return reject(tx, 'ALREADY_REVERSED');
  if (!tx.money.equals(reference.money)) return reject(tx, 'AMOUNT_MISMATCH');

  return applyMovement(input, reference);
}

function waitForReference(tx: WagerTransaction): ApplyOutcome {
  // Só muda de estado na primeira vez. No reprocessamento ele já está em PENDING_REFERENCE.
  if (tx.status === Status.Pending) tx.markPendingReference();
  return { type: 'PENDING_REFERENCE' };
}

function applyMovement(input: ApplyInput, reference: WagerTransaction | undefined): ApplyOutcome {
  const { transaction: tx, wallet, entryId, now } = input;
  const direction = tx.ledgerDirectionFor(reference);
  const props = { amount: tx.money, transactionId: tx.id, entryId, at: now };

  try {
    const movement =
      direction === LedgerDirection.Debit ? wallet.debit(props) : wallet.credit(props);
    tx.markProcessed(reference?.id, now);
    return { type: 'PROCESSED', wallet: movement.wallet, entry: movement.entry };
  } catch (error) {
    if (error instanceof WalletError && error.code === 'INSUFFICIENT_FUNDS') {
      // Código diferente: aposta sem saldo e reversão sem saldo são problemas diferentes.
      return reject(tx, reference ? 'REVERSAL_WOULD_OVERDRAW' : 'INSUFFICIENT_FUNDS');
    }
    throw error;
  }
}
