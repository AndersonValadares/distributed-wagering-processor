ALTER TABLE wager_transaction ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE wager_transaction ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX wager_tx_pending_reference_idx
  ON wager_transaction (next_attempt_at)
  WHERE status = 'PENDING_REFERENCE';
