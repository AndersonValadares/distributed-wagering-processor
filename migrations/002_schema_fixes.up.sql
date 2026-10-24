-- 1) Status PENDING (transação aceita, ainda não aplicada)
ALTER TABLE wager_transaction DROP CONSTRAINT wager_transaction_status_check;
ALTER TABLE wager_transaction ADD CONSTRAINT wager_transaction_status_check
  CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));

-- 2) Idempotency key única por provider, não global
ALTER TABLE wager_transaction DROP CONSTRAINT wager_transaction_idempotency_key_key;
ALTER TABLE wager_transaction ADD CONSTRAINT wager_transaction_provider_idempotency_key
  UNIQUE (provider_id, idempotency_key);

-- 3) Ledger com saldo anterior e aritmética verificada no banco
ALTER TABLE wallet_ledger_entry ADD COLUMN balance_before_cents bigint;
UPDATE wallet_ledger_entry SET balance_before_cents =
  CASE direction
    WHEN 'DEBIT'  THEN balance_after_cents + amount_cents
    ELSE balance_after_cents - amount_cents
  END;
ALTER TABLE wallet_ledger_entry ALTER COLUMN balance_before_cents SET NOT NULL;
ALTER TABLE wallet_ledger_entry ADD CONSTRAINT ledger_balance_before_nonneg
  CHECK (balance_before_cents >= 0);
ALTER TABLE wallet_ledger_entry ADD CONSTRAINT ledger_arithmetic_ok
  CHECK (
    (direction = 'DEBIT'  AND balance_before_cents - amount_cents = balance_after_cents) OR
    (direction = 'CREDIT' AND balance_before_cents + amount_cents = balance_after_cents)
  );

-- 4) Inbox com hash do payload e marca de processamento
ALTER TABLE inbox_message ADD COLUMN payload_hash text NOT NULL DEFAULT '';
ALTER TABLE inbox_message ADD COLUMN processed_at timestamptz;
