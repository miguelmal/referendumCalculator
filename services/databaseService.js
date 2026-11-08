/**
 * databaseService.js
 * Vercel KV / Upstash Redis / Redis-backed envelope & Connect event store.
 *
 * Connection priority:
 *   1. Upstash / Vercel KV HTTP REST (`@upstash/redis`):
 *      Uses UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *      or   KV_REST_API_URL + KV_REST_API_TOKEN.
 *      (Recommended on Vercel Serverless — stateless HTTP, no TCP socket limits.)
 *   2. Redis TCP / TLS (`redis`):
 *      Uses KV_URL or REDIS_URL (or redis://localhost:6379 for local dev).
 *   3. In-memory fallback (when running on Vercel before a KV store is linked):
 *      Prevents webhook/API crashes during initial testing.
 *
 * Keys:
 *   envelope:{envelopeId}        → JSON of normalized envelope
 *   active_presentaciones        → Set of active Presentacion de Casos ids
 *   document_field:{id}          → Hash of extra per-envelope fields
 *   connect_event:{eventId}      → JSON of stored Connect webhook event
 *   connect_events               → List (newest-first) of eventIds
 *   connect_events:{envelopeId}  → List of eventIds for one envelope
 */

const redis = require('redis');
const { Redis: UpstashRedis } = require('@upstash/redis');

function parseJson(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * In-memory adapter with the same normalized interface as the Redis adapters.
 * Used only as a safety fallback on Vercel if no KV/Redis env vars are set.
 */
class MemoryAdapter {
  constructor() {
    this.kv = new Map();
    this.sets = new Map();
    this.hashes = new Map();
    this.lists = new Map();
  }

  async get(key) {
    return this.kv.has(key) ? this.kv.get(key) : null;
  }

  async set(key, value) {
    this.kv.set(key, value);
  }

  async keys(pattern) {
    const prefix = pattern.replace(/\*$/, '');
    return Array.from(this.kv.keys()).filter(k => k.startsWith(prefix));
  }

  async sAdd(key, member) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    this.sets.get(key).add(member);
  }

  async sRem(key, member) {
    if (this.sets.has(key)) this.sets.get(key).delete(member);
  }

  async sMembers(key) {
    return this.sets.has(key) ? Array.from(this.sets.get(key)) : [];
  }

  async hSet(key, field, value) {
    if (!this.hashes.has(key)) this.hashes.set(key, {});
    this.hashes.get(key)[field] = String(value);
  }

  async hGetAll(key) {
    return this.hashes.has(key) ? { ...this.hashes.get(key) } : {};
  }

  async lPush(key, value) {
    if (!this.lists.has(key)) this.lists.set(key, []);
    this.lists.get(key).unshift(value);
  }

  async lRange(key, start, stop) {
    const list = this.lists.get(key) || [];
    return list.slice(start, stop + 1);
  }
}

/**
 * Adapter wrapping `@upstash/redis` (Vercel KV / Upstash HTTP REST API)
 * to expose the unified method names used by DatabaseService.
 */
class UpstashAdapter {
  constructor(url, token) {
    this.client = new UpstashRedis({ url, token });
  }

  async get(key) {
    return await this.client.get(key);
  }

  async set(key, value) {
    await this.client.set(key, value);
  }

  async keys(pattern) {
    return (await this.client.keys(pattern)) || [];
  }

  async sAdd(key, member) {
    await this.client.sadd(key, member);
  }

  async sRem(key, member) {
    await this.client.srem(key, member);
  }

  async sMembers(key) {
    return (await this.client.smembers(key)) || [];
  }

  async hSet(key, field, value) {
    await this.client.hset(key, { [field]: String(value) });
  }

  async hGetAll(key) {
    return (await this.client.hgetall(key)) || {};
  }

  async lPush(key, value) {
    await this.client.lpush(key, value);
  }

  async lRange(key, start, stop) {
    return (await this.client.lrange(key, start, stop)) || [];
  }
}

class DatabaseService {
  constructor() {
    this._client = null;
    this._connecting = null;
    this._mode = null; // 'upstash-rest' | 'redis-tcp' | 'memory'
  }

  async connect() {
    if (this._client) {
      if (this._mode === 'redis-tcp' && !this._client.isOpen) {
        this._client = null;
      } else {
        return;
      }
    }

    if (!this._connecting) {
      this._connecting = (async () => {
        try {
          const restUrl =
            process.env.UPSTASH_REDIS_REST_URL ||
            process.env.KV_REST_API_URL ||
            null;
          const restToken =
            process.env.UPSTASH_REDIS_REST_TOKEN ||
            process.env.KV_REST_API_TOKEN ||
            null;
          const tcpUrl =
            process.env.REDIS_URL ||
            process.env.KV_URL ||
            null;

          console.log('🗄️  [DB] Initializing connection...', {
            isVercel: Boolean(process.env.VERCEL),
            vercelEnv: process.env.VERCEL_ENV || null,
            hasUpstashRestUrl: Boolean(process.env.UPSTASH_REDIS_REST_URL),
            hasKvRestApiUrl: Boolean(process.env.KV_REST_API_URL),
            hasRedisUrl: Boolean(process.env.REDIS_URL),
            hasKvUrl: Boolean(process.env.KV_URL),
          });

          if (restUrl && restToken) {
            this._client = new UpstashAdapter(restUrl, restToken);
            this._mode = 'upstash-rest';
            console.log('🔌 [DB] Connected to Vercel KV / Upstash Redis (REST)');
          } else if (tcpUrl || !process.env.VERCEL) {
            const url = tcpUrl || 'redis://localhost:6379';
            const tcpClient = redis.createClient({ url });
            tcpClient.on('error', err =>
              console.error('⚠️  [DB] Redis TCP Client Error:', err.stack || err.message)
            );
            await tcpClient.connect();
            this._client = tcpClient;
            this._mode = 'redis-tcp';
            console.log('🔌 [DB] Connected to Redis (TCP)');
          } else {
            console.warn(
              '⚠️  [DB] No Vercel KV / Upstash Redis environment variables found ' +
              '(KV_REST_API_URL, UPSTASH_REDIS_REST_URL, KV_URL, or REDIS_URL). ' +
              'Using ephemeral in-memory store.'
            );
            this._client = new MemoryAdapter();
            this._mode = 'memory';
          }
        } catch (err) {
          console.error('❌ [DB] Connection failed:', err.stack || err.message);
          throw err;
        } finally {
          this._connecting = null;
        }
      })();
    }
    await this._connecting;
  }

  getDiagnostics() {
    return {
      mode: this._mode || 'uninitialized',
      isVercel: Boolean(process.env.VERCEL),
      vercelEnv: process.env.VERCEL_ENV || null,
      envConfigured: {
        upstashRest: Boolean(
          (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
          (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
        ),
        redisTcp: Boolean(process.env.REDIS_URL || process.env.KV_URL),
        docusignKey: Boolean(process.env.DOCUSIGN_INTEGRATION_KEY),
        docusignUser: Boolean(process.env.DOCUSIGN_USER_ID),
        docusignRsaKey: Boolean(process.env.DOCUSIGN_RSA_PRIVATE_KEY),
        connectHmac: Boolean(process.env.DOCUSIGN_CONNECT_HMAC_KEY),
      },
    };
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
    return parseJson(raw);
  }

  async getAllEnvelopes() {
    await this.connect();
    const keys = await this._client.keys('envelope:*');
    if (!keys.length) return [];
    const results = await Promise.all(keys.map(key => this._client.get(key)));
    return results.map(parseJson).filter(Boolean);
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
    if (!ids.length) return [];
    const results = await Promise.all(ids.map(id => this._client.get(`envelope:${id}`)));
    return results.map(parseJson).filter(Boolean);
  }

  async saveDocumentField(envelopeId, fieldName, value) {
    await this.connect();
    await this._client.hSet(`document_field:${envelopeId}`, fieldName, String(value));
  }

  async getDocumentFields(envelopeId) {
    await this.connect();
    return (await this._client.hGetAll(`document_field:${envelopeId}`)) || {};
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
    return parseJson(raw);
  }

  /**
   * Lists the most recent Connect events (global), newest first.
   * @param {number} limit
   */
  async getConnectEvents(limit = 50) {
    await this.connect();
    const ids = await this._client.lRange('connect_events', 0, Math.max(0, limit - 1));
    if (!ids.length) return [];
    const results = await Promise.all(ids.map(id => this._client.get(`connect_event:${id}`)));
    return results.map(parseJson).filter(Boolean);
  }

  /**
   * Lists Connect events for a specific envelope, newest first.
   */
  async getConnectEventsByEnvelope(envelopeId, limit = 50) {
    await this.connect();
    const ids = await this._client.lRange(`connect_events:${envelopeId}`, 0, Math.max(0, limit - 1));
    if (!ids.length) return [];
    const results = await Promise.all(ids.map(id => this._client.get(`connect_event:${id}`)));
    return results.map(parseJson).filter(Boolean);
  }

  async logApiCall() {
    // Redis cache does not persist API audit logs.
  }
}

module.exports = new DatabaseService();
