/**
 * services/db/postgresDriver.js
 * Production PostgreSQL repository driver.
 * Implements the exact same relational repository interface as RedisDriver.
 *
 * Activated with DB_PROVIDER=postgres. Connection string comes from
 * POSTGRES_URL or DATABASE_URL. The schema (`schema.sql`) is applied on connect.
 */

const fs = require('fs');
const path = require('path');
const {
  toTemplateRow,
  fromTemplateRow,
  toEnvelopeRow,
  fromEnvelopeRow,
  toConnectEventRow,
  fromConnectEventRow,
} = require('./models');

class PostgresDriver {
  constructor(connectionString) {
    this.connectionString =
      connectionString ||
      process.env.POSTGRES_URL ||
      process.env.DATABASE_URL;
    this._pool = null;
    this._schemaEnsured = false;
    this.mode = 'postgres';
  }

  async connect() {
    if (!this._pool) {
      let Pool;
      try {
        ({ Pool } = require('pg'));
      } catch {
        throw new Error('PostgreSQL driver requires the "pg" package (`npm install pg`).');
      }

      this._pool = new Pool({
        connectionString: this.connectionString,
        ssl:
          process.env.PGSSLMODE === 'disable' || /localhost|127\.0\.0\.1/.test(this.connectionString || '')
            ? false
            : { rejectUnauthorized: false },
      });
      console.log('🔌 [DB] Connected to PostgreSQL pool');
    }

    if (!this._schemaEnsured) {
      const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      await this._pool.query(schemaSql);
      this._schemaEnsured = true;
    }
  }

  // ─── `envelopes` table ─────────────────────────────────────────────────────

  async saveEnvelope(envelopeId, data) {
    await this.connect();
    const existingRes = await this._pool.query(
      'SELECT * FROM envelopes WHERE envelope_id = $1',
      [envelopeId]
    );
    const row = toEnvelopeRow(envelopeId, data, existingRes.rows[0] || null);

    await this._pool.query(
      `INSERT INTO envelopes (
        envelope_id, template_id, template_type, subject, status,
        content_text, hora_final_voto, expires_at, closed_at,
        created_date_time, last_modified, is_active_presentacion, tracking_disabled,
        total_voters, voted_count, no_vote_count, quorum_threshold, has_quorum,
        totals, recipients, available_choices, template_fields, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15, $16, $17, $18,
        $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb, NOW()
      )
      ON CONFLICT (envelope_id) DO UPDATE SET
        template_id            = EXCLUDED.template_id,
        template_type          = EXCLUDED.template_type,
        subject                = EXCLUDED.subject,
        status                 = EXCLUDED.status,
        content_text           = EXCLUDED.content_text,
        hora_final_voto        = EXCLUDED.hora_final_voto,
        expires_at             = EXCLUDED.expires_at,
        closed_at              = EXCLUDED.closed_at,
        created_date_time      = EXCLUDED.created_date_time,
        last_modified          = EXCLUDED.last_modified,
        is_active_presentacion = EXCLUDED.is_active_presentacion,
        tracking_disabled      = EXCLUDED.tracking_disabled,
        total_voters           = EXCLUDED.total_voters,
        voted_count            = EXCLUDED.voted_count,
        no_vote_count          = EXCLUDED.no_vote_count,
        quorum_threshold       = EXCLUDED.quorum_threshold,
        has_quorum             = EXCLUDED.has_quorum,
        totals                 = EXCLUDED.totals,
        recipients             = EXCLUDED.recipients,
        available_choices      = EXCLUDED.available_choices,
        template_fields        = EXCLUDED.template_fields,
        updated_at             = NOW()`,
      [
        row.envelope_id,
        row.template_id,
        row.template_type,
        row.subject,
        row.status,
        row.content_text,
        row.hora_final_voto,
        row.expires_at,
        row.closed_at,
        row.created_date_time,
        row.last_modified,
        row.is_active_presentacion,
        row.tracking_disabled,
        row.total_voters,
        row.voted_count,
        row.no_vote_count,
        row.quorum_threshold,
        row.has_quorum,
        JSON.stringify(row.totals),
        JSON.stringify(row.recipients),
        JSON.stringify(row.available_choices),
        JSON.stringify(row.template_fields),
      ]
    );
    return fromEnvelopeRow(row);
  }

  async getEnvelope(envelopeId) {
    await this.connect();
    const res = await this._pool.query(
      'SELECT * FROM envelopes WHERE envelope_id = $1',
      [envelopeId]
    );
    return fromEnvelopeRow(res.rows[0] || null);
  }

  async getAllEnvelopes() {
    await this.connect();
    const res = await this._pool.query(
      'SELECT * FROM envelopes ORDER BY created_date_time DESC NULLS LAST'
    );
    return res.rows.map(fromEnvelopeRow);
  }

  async addActivePresentacion(envelopeId) {
    await this.connect();
    await this._pool.query(
      'UPDATE envelopes SET is_active_presentacion = TRUE, updated_at = NOW() WHERE envelope_id = $1',
      [envelopeId]
    );
  }

  async removeActivePresentacion(envelopeId) {
    await this.connect();
    await this._pool.query(
      'UPDATE envelopes SET is_active_presentacion = FALSE, updated_at = NOW() WHERE envelope_id = $1',
      [envelopeId]
    );
  }

  async getActivePresentaciones() {
    await this.connect();
    const res = await this._pool.query(
      'SELECT * FROM envelopes WHERE is_active_presentacion = TRUE ORDER BY expires_at ASC NULLS LAST'
    );
    return res.rows.map(fromEnvelopeRow);
  }

  // ─── `connect_events` table ────────────────────────────────────────────────

  async saveConnectEvent(record) {
    await this.connect();
    const row = toConnectEventRow(record);
    await this._pool.query(
      `INSERT INTO connect_events (
        id, received_at, envelope_id, event, status, signature_verified, content_type, raw
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO NOTHING`,
      [
        row.id,
        row.received_at,
        row.envelope_id,
        row.event,
        row.status,
        row.signature_verified,
        row.content_type,
        row.raw,
      ]
    );
    return fromConnectEventRow(row);
  }

  async getConnectEvents(limit = 50) {
    await this.connect();
    const res = await this._pool.query(
      'SELECT * FROM connect_events ORDER BY received_at DESC LIMIT $1',
      [limit]
    );
    return res.rows.map(fromConnectEventRow);
  }

  async getConnectEventsByEnvelope(envelopeId, limit = 50) {
    await this.connect();
    const res = await this._pool.query(
      'SELECT * FROM connect_events WHERE envelope_id = $1 ORDER BY received_at DESC LIMIT $2',
      [envelopeId, limit]
    );
    return res.rows.map(fromConnectEventRow);
  }

  // ─── `templates` table ─────────────────────────────────────────────────────

  async saveTemplate(templateId, data) {
    await this.connect();
    const existingRes = await this._pool.query(
      'SELECT * FROM templates WHERE template_id = $1',
      [templateId]
    );
    const row = toTemplateRow({ ...data, templateId }, existingRes.rows[0] || null);

    await this._pool.query(
      `INSERT INTO templates (
        template_id, name, description, folder_name, shared,
        is_valid, has_radio_buttons, has_checkboxes, vote_control_type,
        radio_groups, checkbox_options, vote_options, text_fields,
        config, created_at, last_modified, last_synced_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
        $14::jsonb, $15, $16, $17
      )
      ON CONFLICT (template_id) DO UPDATE SET
        name              = EXCLUDED.name,
        description       = EXCLUDED.description,
        folder_name       = EXCLUDED.folder_name,
        shared            = EXCLUDED.shared,
        is_valid          = EXCLUDED.is_valid,
        has_radio_buttons = EXCLUDED.has_radio_buttons,
        has_checkboxes    = EXCLUDED.has_checkboxes,
        vote_control_type = EXCLUDED.vote_control_type,
        radio_groups      = EXCLUDED.radio_groups,
        checkbox_options  = EXCLUDED.checkbox_options,
        vote_options      = EXCLUDED.vote_options,
        text_fields       = EXCLUDED.text_fields,
        config            = EXCLUDED.config,
        created_at        = EXCLUDED.created_at,
        last_modified     = EXCLUDED.last_modified,
        last_synced_at    = EXCLUDED.last_synced_at`,
      [
        row.template_id,
        row.name,
        row.description,
        row.folder_name,
        row.shared,
        row.is_valid,
        row.has_radio_buttons,
        row.has_checkboxes,
        row.vote_control_type,
        JSON.stringify(row.radio_groups),
        JSON.stringify(row.checkbox_options),
        JSON.stringify(row.vote_options),
        JSON.stringify(row.text_fields),
        row.config ? JSON.stringify(row.config) : null,
        row.created_at,
        row.last_modified,
        row.last_synced_at,
      ]
    );

    return fromTemplateRow(row);
  }

  async getTemplate(templateId) {
    await this.connect();
    const res = await this._pool.query(
      'SELECT * FROM templates WHERE template_id = $1',
      [templateId]
    );
    return fromTemplateRow(res.rows[0] || null);
  }

  async getAllTemplates() {
    await this.connect();
    const res = await this._pool.query(
      'SELECT * FROM templates ORDER BY created_at DESC NULLS LAST'
    );
    return res.rows.map(fromTemplateRow);
  }

  async saveTemplateConfig(templateId, configData) {
    await this.connect();
    const existing = await this.getTemplate(templateId);
    const updatedConfig = {
      ...((existing && existing.config) || {}),
      ...configData,
      updatedAt: new Date().toISOString(),
    };
    return await this.saveTemplate(templateId, {
      ...(existing || { templateId }),
      config: updatedConfig,
    });
  }

  // ─── `sync_meta` table ─────────────────────────────────────────────────────

  async getSyncMeta(field) {
    await this.connect();
    const res = await this._pool.query(
      'SELECT meta_value FROM sync_meta WHERE meta_key = $1',
      [field]
    );
    return res.rows[0] ? res.rows[0].meta_value : null;
  }

  async setSyncMeta(field, value) {
    await this.connect();
    await this._pool.query(
      `INSERT INTO sync_meta (meta_key, meta_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (meta_key) DO UPDATE SET meta_value = EXCLUDED.meta_value, updated_at = NOW()`,
      [field, String(value)]
    );
  }

  async getAllSyncMeta() {
    await this.connect();
    const res = await this._pool.query('SELECT meta_key, meta_value FROM sync_meta');
    const out = {};
    for (const r of res.rows) {
      out[r.meta_key] = r.meta_value;
    }
    return out;
  }
}

module.exports = PostgresDriver;
