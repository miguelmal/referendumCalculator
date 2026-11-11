-- ============================================================================
-- DocuSign Vote Counter — PostgreSQL Schema
-- ============================================================================

CREATE TABLE IF NOT EXISTS templates (
  template_id        VARCHAR(128) PRIMARY KEY,
  name               VARCHAR(255) NOT NULL,
  description        TEXT DEFAULT '',
  folder_name        VARCHAR(255) DEFAULT '',
  shared             BOOLEAN DEFAULT FALSE,
  is_valid           BOOLEAN DEFAULT FALSE,
  has_radio_buttons  BOOLEAN DEFAULT FALSE,
  has_checkboxes     BOOLEAN DEFAULT FALSE,
  vote_control_type  VARCHAR(32) DEFAULT 'none',
  radio_groups       JSONB DEFAULT '[]'::jsonb,
  checkbox_options   JSONB DEFAULT '[]'::jsonb,
  vote_options       JSONB DEFAULT '[]'::jsonb,
  text_fields        JSONB DEFAULT '[]'::jsonb,
  config             JSONB DEFAULT NULL,
  created_at         TIMESTAMPTZ NULL,
  last_modified      TIMESTAMPTZ NULL,
  last_synced_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_templates_is_valid ON templates (is_valid);
CREATE INDEX IF NOT EXISTS idx_templates_created_at ON templates (created_at DESC);

CREATE TABLE IF NOT EXISTS envelopes (
  envelope_id            VARCHAR(128) PRIMARY KEY,
  template_id            VARCHAR(128) NULL, -- soft reference: envelopes may arrive before their template is synced
  template_type          VARCHAR(255) NOT NULL,
  subject                TEXT DEFAULT '',
  status                 VARCHAR(64) NOT NULL DEFAULT 'sent',
  content_text           TEXT DEFAULT '',
  hora_final_voto        VARCHAR(128) NULL,
  expires_at             TIMESTAMPTZ NULL,
  closed_at              TIMESTAMPTZ NULL,
  created_date_time      TIMESTAMPTZ NULL,
  last_modified          TIMESTAMPTZ NULL,
  is_active_presentacion BOOLEAN DEFAULT FALSE,
  tracking_disabled      BOOLEAN DEFAULT FALSE,
  total_voters           INT DEFAULT 0,
  voted_count            INT DEFAULT 0,
  no_vote_count          INT DEFAULT 0,
  quorum_threshold       INT DEFAULT 0,
  has_quorum             BOOLEAN DEFAULT FALSE,
  totals                 JSONB DEFAULT '{}'::jsonb,
  recipients             JSONB DEFAULT '[]'::jsonb,
  available_choices      JSONB DEFAULT '[]'::jsonb,
  template_fields        JSONB DEFAULT '{}'::jsonb,
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- Migration for databases created with the earlier FK version
ALTER TABLE envelopes DROP CONSTRAINT IF EXISTS envelopes_template_id_fkey;

CREATE INDEX IF NOT EXISTS idx_envelopes_status ON envelopes (status);
CREATE INDEX IF NOT EXISTS idx_envelopes_active_deadline ON envelopes (is_active_presentacion, expires_at)
  WHERE is_active_presentacion = TRUE;

CREATE TABLE IF NOT EXISTS connect_events (
  id                 UUID PRIMARY KEY,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  envelope_id        VARCHAR(128) NULL,
  event              VARCHAR(128) NULL,
  status             VARCHAR(64) NULL,
  signature_verified BOOLEAN DEFAULT FALSE,
  content_type       VARCHAR(128) NULL,
  raw                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connect_events_received_at ON connect_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_connect_events_envelope_id ON connect_events (envelope_id, received_at DESC);

CREATE TABLE IF NOT EXISTS sync_meta (
  meta_key           VARCHAR(128) PRIMARY KEY,
  meta_value         TEXT NOT NULL,
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
