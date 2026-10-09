CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  campaign_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  game_state JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  active_chat_turn_id UUID,
  active_chat_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS game_events (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, id)
);
CREATE TABLE IF NOT EXISTS chat_turns (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  scene_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  client_turn_id UUID NOT NULL,
  user_message TEXT NOT NULL DEFAULT '',
  response_json JSONB,
  lease_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_turns_idempotency_idx ON chat_turns(campaign_id, client_turn_id);
ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
CREATE TABLE IF NOT EXISTS memory_outbox (
  memory_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  character_id TEXT NOT NULL,
  fact_key_hash TEXT,
  revision INTEGER NOT NULL,
  namespace TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','accepted','pending_unknown','confirmed','failed')),
  job_id TEXT UNIQUE,
  blob_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, character_id, fact_key_hash, revision)
);
CREATE TABLE IF NOT EXISTS memory_receipts (
  memory_id UUID PRIMARY KEY REFERENCES memory_outbox(memory_id),
  job_id TEXT NOT NULL UNIQUE,
  blob_id TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recall_verified_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS fact_heads (
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  character_id TEXT NOT NULL,
  fact_key_hash TEXT NOT NULL,
  active_revision INTEGER NOT NULL,
  active_memory_id UUID,
  pending_revision INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(campaign_id, character_id, fact_key_hash)
);
CREATE TABLE IF NOT EXISTS memory_tombstones (
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  character_id TEXT NOT NULL,
  fact_key_hash TEXT NOT NULL,
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL,
  PRIMARY KEY(campaign_id, character_id, fact_key_hash)
);
CREATE INDEX IF NOT EXISTS memory_outbox_pending_idx ON memory_outbox(next_attempt_at) WHERE status IN ('queued','accepted','pending_unknown');
-- Non-content classification lets bounded recall retain dynamic preferences.
-- Legacy confirmed rows stay NULL; never reconstruct text from PostgreSQL.
ALTER TABLE memory_outbox ADD COLUMN IF NOT EXISTS memory_kind TEXT CHECK (memory_kind IN ('preference','promise','reason','episode','summary'));
-- Action IDs belong to a campaign, rather than all users sharing a global ID space.
ALTER TABLE game_events DROP CONSTRAINT IF EXISTS game_events_pkey;
ALTER TABLE game_events ADD PRIMARY KEY(campaign_id,id);
CREATE TABLE IF NOT EXISTS cooperation_drafts (
 id UUID NOT NULL, campaign_id UUID NOT NULL REFERENCES campaigns(id),
 expected_version INTEGER NOT NULL, payload_ciphertext TEXT NOT NULL,
 confirmed_memory_id UUID, expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '30 minutes',
 PRIMARY KEY(campaign_id,id)
);
CREATE TABLE IF NOT EXISTS cooperation_proposals (
 id UUID NOT NULL, campaign_id UUID NOT NULL REFERENCES campaigns(id),
 scene_id TEXT NOT NULL, expected_version INTEGER NOT NULL,
 action_id TEXT NOT NULL, memory_id UUID NOT NULL, revision INTEGER NOT NULL,
 blob_id TEXT NOT NULL, checksum TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '10 minutes',
 PRIMARY KEY(campaign_id,id)
);
ALTER TABLE cooperation_proposals ADD COLUMN IF NOT EXISTS episode_ids UUID[] NOT NULL DEFAULT '{}';
