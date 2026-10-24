ALTER TABLE inbox_message DROP COLUMN processed_at;
ALTER TABLE inbox_message DROP COLUMN payload_hash;

ALTER TABLE wallet_ledger_entry DROP CONSTRAINT ledger_arithmetic_ok;
ALTER TABLE wallet_ledger_entry DROP CONSTRAINT ledger_balance_before_nonneg;
ALTER TABLE wallet_ledger_entry DROP COLUMN balance_before_cents;

ALTER TABLE wager_transaction DROP CONSTRAINT wager_transaction_provider_idempotency_key;
ALTER TABLE wager_transaction ADD CONSTRAINT wager_transaction_idempotency_key_key
  UNIQUE (idempotency_key);

ALTER TABLE wager_transaction DROP CONSTRAINT wager_transaction_status_check;
ALTER TABLE wager_transaction ADD CONSTRAINT wager_transaction_status_check
  CHECK (status IN ('PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'));
