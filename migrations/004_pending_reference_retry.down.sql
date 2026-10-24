DROP INDEX wager_tx_pending_reference_idx;
ALTER TABLE wager_transaction DROP COLUMN next_attempt_at;
ALTER TABLE wager_transaction DROP COLUMN attempts;
