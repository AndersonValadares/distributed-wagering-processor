import { Money } from '../shared/money.ts';
import { LedgerDirection } from '../wagering/wager-transaction.ts';
import { WalletLedgerEntry } from '../wagering/wallet-ledger-entry.ts';

export type WalletErrorCode = 'INSUFFICIENT_FUNDS' | 'CURRENCY_MISMATCH';

export class WalletError extends Error {
  constructor(
    readonly code: WalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

export type WalletState = {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type MovementProps = {
  amount: Money;
  transactionId: string;
  entryId: string;
  at: Date;
};

/** Resultado de uma movimentação: a nova wallet e o lançamento que a explica. */
export type WalletMovement = {
  wallet: Wallet;
  entry: WalletLedgerEntry;
};

export class Wallet {
  private constructor(private readonly state: Readonly<WalletState>) {}

  /** Wallet nova: version começa em 1. */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at?: Date;
  }): Wallet {
    const at = props.at ?? new Date();
    return new Wallet({
      id: props.id,
      playerId: props.playerId,
      balance: props.initialBalance,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
  }

  /** Reconstrói a partir do banco. Não revalida: o estado já foi aceito antes. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet({ ...state });
  }

  get id() { return this.state.id; }
  get playerId() { return this.state.playerId; }
  get currency() { return this.state.balance.currency; }
  get balance() { return this.state.balance; }
  get version() { return this.state.version; }
  get createdAt() { return this.state.createdAt; }
  get updatedAt() { return this.state.updatedAt; }

  /** Subtrai o valor. Recusa saldo insuficiente. Devolve nova wallet + lançamento. */
  debit(props: MovementProps): WalletMovement {
    this.assertSameCurrency(props.amount);
    if (props.amount.cents > this.balance.cents) {
      throw new WalletError('INSUFFICIENT_FUNDS', 'saldo insuficiente');
    }
    return this.move(LedgerDirection.Debit, props, this.balance.subtract(props.amount));
  }

  /** Soma o valor. Devolve nova wallet + lançamento. */
  credit(props: MovementProps): WalletMovement {
    this.assertSameCurrency(props.amount);
    return this.move(LedgerDirection.Credit, props, this.balance.add(props.amount));
  }

  private move(
    direction: LedgerDirection,
    props: MovementProps,
    newBalance: Money,
  ): WalletMovement {
    // O lançamento é criado primeiro: se a aritmética estiver errada, nada muda.
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.amount,
      balanceBefore: this.balance,
      balanceAfter: newBalance,
      createdAt: props.at,
    });
    const wallet = new Wallet({
      ...this.state,
      balance: newBalance,
      version: this.version + 1,
      updatedAt: props.at,
    });
    return { wallet, entry };
  }

  private assertSameCurrency(amount: Money): void {
    if (amount.currency !== this.balance.currency) {
      throw new WalletError(
        'CURRENCY_MISMATCH',
        `moedas diferentes: ${this.balance.currency} e ${amount.currency}`,
      );
    }
  }
}
