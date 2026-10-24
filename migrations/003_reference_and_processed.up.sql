ALTER TABLE wager_transaction ADD COLUMN reference_external_transaction_id text;
ALTER TABLE wager_transaction ADD COLUMN processed_at timestamptz;
ALTER TABLE wager_transaction ADD CONSTRAINT wager_tx_failure_code_required
  CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL));
