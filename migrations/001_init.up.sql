CREATE TABLE wallet (
  id uuid PRIMARY KEY,
  player_id uuid NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance_cents bigint NOT NULL CHECK (balance_cents >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_player_currency_key UNIQUE (player_id, currency)
);

CREATE TABLE wager_transaction (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  external_transaction_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  wallet_id uuid NOT NULL REFERENCES wallet(id),
  player_id uuid NOT NULL,
  round_id text NOT NULL,
  game_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
  currency char(3) NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  status text NOT NULL CHECK (status IN ('PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED')),
  failure_code text,
  reference_transaction_id uuid REFERENCES wager_transaction(id),
  balance_after_cents bigint CHECK (balance_after_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wager_transaction_provider_external_key UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wager_transaction_idempotency_key_key UNIQUE (idempotency_key)
);

-- Cada transação pode ser revertida no máximo uma vez
CREATE UNIQUE INDEX one_reversal_per_transaction
  ON wager_transaction (reference_transaction_id)
  WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';

CREATE TABLE wallet_ledger_entry (
  id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES wallet(id),
  transaction_id uuid NOT NULL UNIQUE REFERENCES wager_transaction(id),
  direction text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  balance_after_cents bigint NOT NULL CHECK (balance_after_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ledger imutável: bloqueia UPDATE e DELETE
CREATE FUNCTION forbid_ledger_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entry é imutável';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallet_ledger_immutable
  BEFORE UPDATE OR DELETE ON wallet_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_change();

CREATE TABLE inbox_message (
  consumer_name text NOT NULL,
  message_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_message (
  id uuid PRIMARY KEY,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);

-- Índice parcial: a busca de eventos pendentes continua barata
CREATE INDEX outbox_pending_idx
  ON outbox_message (next_attempt_at)
  WHERE published_at IS NULL;