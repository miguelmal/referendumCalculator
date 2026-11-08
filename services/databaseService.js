/**
 * databaseService.js
 * Redis-backed envelope cache (voided DocuSign envelopes lose form data).
 *
 * Keys:
 *   envelope:{envelopeId}  → JSON of normalized envelope
 *   active_presentaciones  → Set of active Presentacion de Casos ids
 *   document_field:{id}    → Hash of extra per-envelope fields
 */

const redis = require('redis');

class DatabaseService {
  constructor() {
    this._client = null;
    this._connecting = null;
  }

  async connect() {
    if (this._client && this._client.isOpen) return;

    if (!this._connecting) {
      this._connecting = (async () => {
        this._client = redis.createClient({
          url: process.env.REDIS_URL || 'redis://localhost:6379',
        });
        this._client.on('error', err =>
          console.error('⚠️  Redis Client Error:', err.message)
        );
        await this._client.connect();
        console.log('🔌 Connected to Redis');
        this._connecting = null;
      })();
    }
    await this._connecting;
  }

  /** No schema; kept so boot can call a single setup hook. */
  async ensureSchema() {
    await this.connect();
  }

  async saveEnvelope(envelopeId, data) {
    await this.connect();
    const existing = await this.getEnvelope(envelopeId);
    const merged = existing ? { ...existing, ...data } : data;
    if (existing) {
      if (!data.contentText && existing.contentText) merged.contentText = existing.contentText;
      if (!data.horaFinalVoto && existing.horaFinalVoto) merged.horaFinalVoto = existing.horaFinalVoto;
      if (!data.expiresAt && existing.expiresAt) merged.expiresAt = existing.expiresAt;
    }
    await this._client.set(`envelope:${envelopeId}`, JSON.stringify(merged));
  }

  async getEnvelope(envelopeId) {
    await this.connect();
    const raw = await this._client.get(`envelope:${envelopeId}`);
    return raw ? JSON.parse(raw) : null;
  }

  async getAllEnvelopes() {
    await this.connect();
    const keys = await this._client.keys('envelope:*');
    const envelopes = [];
    for (const key of keys) {
      const raw = await this._client.get(key);
      if (raw) envelopes.push(JSON.parse(raw));
    }
    return envelopes;
  }

  async getLatestEnvelopeDate() {
    const envelopes = await this.getAllEnvelopes();
    let max = null;
    for (const env of envelopes) {
      if (!env.lastModified) continue;
      const d = new Date(env.lastModified);
      if (!isNaN(d.getTime()) && (!max || d > max)) max = d;
    }
    if (max) {
      max.setDate(max.getDate() - 1);
      return max.toISOString();
    }
    return '2000-01-01T00:00:00Z';
  }

  async addActivePresentacion(envelopeId) {
    await this.connect();
    await this._client.sAdd('active_presentaciones', envelopeId);
  }

  async removeActivePresentacion(envelopeId) {
    await this.connect();
    await this._client.sRem('active_presentaciones', envelopeId);
  }

  async getActivePresentaciones() {
    await this.connect();
    const ids = await this._client.sMembers('active_presentaciones');
    const envelopes = [];
    for (const id of ids) {
      const raw = await this._client.get(`envelope:${id}`);
      if (raw) envelopes.push(JSON.parse(raw));
    }
    return envelopes;
  }

  async saveDocumentField(envelopeId, fieldName, value) {
    await this.connect();
    await this._client.hSet(`document_field:${envelopeId}`, fieldName, String(value));
  }

  async getDocumentFields(envelopeId) {
    await this.connect();
    return await this._client.hGetAll(`document_field:${envelopeId}`);
  }

  // ─── DocuSign Connect (webhook) events ──────────────────────────────────
  // Raw inbound Connect payloads are stored verbatim so no vote data is lost.
  // Keys:
  //   connect_event:{eventId}        → JSON of the stored event record
  //   connect_events                 → List (newest-first) of eventIds
  //   connect_events:{envelopeId}    → List of eventIds for one envelope

  /**
   * Persists a single Connect event record.
   * @param {object} record - { id, receivedAt, envelopeId, event, status, signature, raw, headers }
   * @returns {Promise<object>} the stored record
   */
  async saveConnectEvent(record) {
    await this.connect();
    const id = record.id;
    await this._client.set(`connect_event:${id}`, JSON.stringify(record));
    // Newest-first global index.
    await this._client.lPush('connect_events', id);
    // Per-envelope index (when the envelopeId is known).
    if (record.envelopeId) {
      await this._client.lPush(`connect_events:${record.envelopeId}`, id);
    }
    return record;
  }

  async getConnectEvent(eventId) {
    await this.connect();
    const raw = await this._client.get(`connect_event:${eventId}`);
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Lists the most recent Connect events (global), newest first.
   * @param {number} limit
   */
  async getConnectEvents(limit = 50) {
    await this.connect();
    const ids = await this._client.lRange('connect_events', 0, Math.max(0, limit - 1));
    const events = [];
    for (const id of ids) {
      const raw = await this._client.get(`connect_event:${id}`);
      if (raw) events.push(JSON.parse(raw));
    }
    return events;
  }

  /**
   * Lists Connect events for a specific envelope, newest first.
   */
  async getConnectEventsByEnvelope(envelopeId, limit = 50) {
    await this.connect();
    const ids = await this._client.lRange(`connect_events:${envelopeId}`, 0, Math.max(0, limit - 1));
    const events = [];
    for (const id of ids) {
      const raw = await this._client.get(`connect_event:${id}`);
      if (raw) events.push(JSON.parse(raw));
    }
    return events;
  }

  async logApiCall() {
    // Redis cache does not persist API audit logs.
  }
}

module.exports = new DatabaseService();
