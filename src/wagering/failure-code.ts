/** O que o provedor deve fazer ao receber este código. */
export type ProviderAction = 'RETRY' | 'FIX_PAYLOAD' | 'GIVE_UP';

export const FAILURE_CODES = {
  // --- Regras de negócio (REJECTED) ---
  INSUFFICIENT_FUNDS: { action: 'GIVE_UP', description: 'BET sem saldo suficiente' },
  REVERSAL_WOULD_OVERDRAW: {
    action: 'GIVE_UP',
    description: 'a reversão deixaria o saldo negativo',
  },
  REFERENCE_NOT_FOUND: {
    action: 'FIX_PAYLOAD',
    description: 'a referência não chegou dentro do prazo',
  },
  REFERENCE_MISMATCH: {
    action: 'FIX_PAYLOAD',
    description: 'referência de outro provider, player, wallet, moeda ou rodada',
  },
    REFERENCE_NOT_PROCESSED: {
    action: 'GIVE_UP',
    description: 'a referência foi rejeitada ou falhou, então não há o que reverter',
  },
  INVALID_REFERENCE_KIND: {
    action: 'FIX_PAYLOAD',
    description: 'tipo de operação não pode referenciar este tipo',
  },
  ALREADY_REVERSED: { action: 'GIVE_UP', description: 'a referência já foi revertida' },
  AMOUNT_MISMATCH: {
    action: 'FIX_PAYLOAD',
    description: 'valor da reversão difere do valor da referência',
  },
  CURRENCY_MISMATCH: {
    action: 'FIX_PAYLOAD',
    description: 'moeda diferente da moeda da wallet',
  },
  WALLET_NOT_FOUND: { action: 'FIX_PAYLOAD', description: 'wallet inexistente' },
  // --- Infraestrutura (FAILED) ---
  INTERNAL_ERROR: { action: 'RETRY', description: 'erro permanente de infraestrutura' },
} as const satisfies Record<string, { action: ProviderAction; description: string }>;

export type FailureCode = keyof typeof FAILURE_CODES;

export function providerActionFor(code: FailureCode): ProviderAction {
  return FAILURE_CODES[code].action;
}
