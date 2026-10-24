import { Money } from '../shared/money.ts';
import { LedgerDirection } from './wager-transaction.ts';

export class LedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerEntryError';
  }
}

export type LedgerEntryState = {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
};

export class WalletLedgerEntry {
  private constructor(private readonly state: Readonly<LedgerEntryState>) {
    Object.freeze(this.state);
  }

  /** Cria um lançamento novo e confere a aritmética. */
  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry({ ...props });
    if (props.money.isZero()) {
      throw new LedgerEntryError('lançamento exige valor maior que zero');
    }
    if (!entry.isBalanced()) {
      throw new LedgerEntryError('aritmética inválida: antes ± valor deve ser igual a depois');
    }
    return entry;
  }

  /** Reconstrói a partir do banco. Não revalida: o banco já garante via CHECK. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry({ ...state });
  }

  get id() { return this.state.id; }
  get walletId() { return this.state.walletId; }
  get transactionId() { return this.state.transactionId; }
  get direction() { return this.state.direction; }
  get money() { return this.state.money; }
  get balanceBefore() { return this.state.balanceBefore; }
  get balanceAfter() { return this.state.balanceAfter; }
  get createdAt() { return this.state.createdAt; }

  /** balanceBefore ± money === balanceAfter. Money recusa negativos, então não há surpresa. */
  isBalanced(): boolean {
    const { direction, money, balanceBefore, balanceAfter } = this.state;
    if (direction === LedgerDirection.Credit) {
      return balanceBefore.add(money).equals(balanceAfter);
    }
    return balanceBefore.cents >= money.cents && balanceBefore.subtract(money).equals(balanceAfter);
  }
}
