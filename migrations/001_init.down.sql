DROP TABLE IF EXISTS outbox_message;
DROP TABLE IF EXISTS inbox_message;
DROP TRIGGER IF EXISTS wallet_ledger_immutable ON wallet_ledger_entry;
DROP TABLE IF EXISTS wallet_ledger_entry;
DROP FUNCTION IF EXISTS forbid_ledger_change();
DROP TABLE IF EXISTS wager_transaction;
DROP TABLE IF EXISTS wallet;
