/**
 * services/db/redisDriver.js
 * Upstash Redis (REST) / TCP Redis / In-Memory repository driver.
 *
 * Uses the canonical relational row models from `services/db/models.js` so
 * stored records mirror the PostgreSQL table schema (`templates`, `envelopes`,
 * `connect_events`, `sync_meta`).
 */

const redis = require('redis');
const { Redis: UpstashRedis } = require('@upstash/redis');
const {
  toTemplateRow,
  fromTemplateRow,
  toEnvelopeRow,
  fromEnvelopeRow,
  toConnectEventRow,
  fromConnectEventRow,
} = require('./models');

function parseJson(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

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

class RedisDriver {
  constructor() {
    this._client = null;
    this._connecting = null;
    this.mode = null; // 'upstash-rest' | 'redis-tcp' | 'memory'
  }

  async connect() {
    if (this._client) {
      if (this.mode === 'redis-tcp' && !this._client.isOpen) {
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

          if (restUrl && restToken) {
            this._client = new UpstashAdapter(restUrl, restToken);
            this.mode = 'upstash-rest';
            console.log('🔌 [DB] Connected to Upstash Redis (REST)');
          } else if (tcpUrl) {
            const tcpClient = redis.createClient({ url: tcpUrl });
            tcpClient.on('error', err =>
              console.error('⚠️  [DB] Redis TCP Client Error:', err.stack || err.message)
            );
            await tcpClient.connect();
            this._client = tcpClient;
            this.mode = 'redis-tcp';
            console.log('🔌 [DB] Connected to Redis (TCP)');
          } else {
            console.warn(
              '⚠️  [DB] No Redis environment variables found (UPSTASH_REDIS_REST_*, KV_REST_API_*, REDIS_URL). ' +
              'Using ephemeral in-memory store.'
            );
            this._client = new MemoryAdapter();
            this.mode = 'memory';
          }
        } finally {
          this._connecting = null;
        }
      })();
    }
    await this._connecting;
  }

  // ─── `envelopes` table ─────────────────────────────────────────────────────

  async saveEnvelope(envelopeId, data) {
    await this.connect();
    const existingRaw = parseJson(await this._client.get(`envelope:${envelopeId}`));
    const row = toEnvelopeRow(envelopeId, data, existingRaw);
    await this._client.set(`envelope:${envelopeId}`, JSON.stringify(row));
    return fromEnvelopeRow(row);
  }

  async getEnvelope(envelopeId) {
    await this.connect();
    const raw = parseJson(await this._client.get(`envelope:${envelopeId}`));
    return fromEnvelopeRow(raw);
  }

  async getAllEnvelopes() {
    await this.connect();
    const keys = await this._client.keys('envelope:*');
    if (!keys.length) return [];
    const results = await Promise.all(keys.map(key => this._client.get(key)));
    return results.map(parseJson).map(fromEnvelopeRow).filter(Boolean);
  }

  async addActivePresentacion(envelopeId) {
    await this.connect();
    await this._client.sAdd('active_presentaciones', envelopeId);
    const existingRaw = parseJson(await this._client.get(`envelope:${envelopeId}`));
    if (existingRaw) {
      existingRaw.is_active_presentacion = true;
      await this._client.set(`envelope:${envelopeId}`, JSON.stringify(existingRaw));
    }
  }

  async removeActivePresentacion(envelopeId) {
    await this.connect();
    await this._client.sRem('active_presentaciones', envelopeId);
    const existingRaw = parseJson(await this._client.get(`envelope:${envelopeId}`));
    if (existingRaw) {
      existingRaw.is_active_presentacion = false;
      await this._client.set(`envelope:${envelopeId}`, JSON.stringify(existingRaw));
    }
  }

  async getActivePresentaciones() {
    await this.connect();
    const ids = await this._client.sMembers('active_presentaciones');
    if (!ids.length) return [];
    const results = await Promise.all(ids.map(id => this._client.get(`envelope:${id}`)));
    return results.map(parseJson).map(fromEnvelopeRow).filter(Boolean);
  }

  // ─── `connect_events` table ────────────────────────────────────────────────

  async saveConnectEvent(record) {
    await this.connect();
    const row = toConnectEventRow(record);
    await this._client.set(`connect_event:${row.id}`, JSON.stringify(row));
    await this._client.lPush('connect_events', row.id);
    if (row.envelope_id) {
      await this._client.lPush(`connect_events:${row.envelope_id}`, row.id);
    }
    return fromConnectEventRow(row);
  }

  async getConnectEvents(limit = 50) {
    await this.connect();
    const ids = await this._client.lRange('connect_events', 0, Math.max(0, limit - 1));
    if (!ids.length) return [];
    const results = await Promise.all(ids.map(id => this._client.get(`connect_event:${id}`)));
    return results.map(parseJson).map(fromConnectEventRow).filter(Boolean);
  }

  async getConnectEventsByEnvelope(envelopeId, limit = 50) {
    await this.connect();
    const ids = await this._client.lRange(`connect_events:${envelopeId}`, 0, Math.max(0, limit - 1));
    if (!ids.length) return [];
    const results = await Promise.all(ids.map(id => this._client.get(`connect_event:${id}`)));
    return results.map(parseJson).map(fromConnectEventRow).filter(Boolean);
  }

  // ─── `templates` table ─────────────────────────────────────────────────────

  async saveTemplate(templateId, data) {
    await this.connect();
    const existingRaw = parseJson(await this._client.get(`template:${templateId}`));
    const row = toTemplateRow({ ...data, templateId }, existingRaw);
    await this._client.set(`template:${templateId}`, JSON.stringify(row));
    return fromTemplateRow(row);
  }

  async getTemplate(templateId) {
    await this.connect();
    const raw = parseJson(await this._client.get(`template:${templateId}`));
    return fromTemplateRow(raw);
  }

  async getAllTemplates() {
    await this.connect();
    const keys = await this._client.keys('template:*');
    if (!keys.length) return [];
    const results = await Promise.all(keys.map(key => this._client.get(key)));
    return results.map(parseJson).map(fromTemplateRow).filter(Boolean);
  }

  async saveTemplateConfig(templateId, configData) {
    await this.connect();
    const existingRaw = parseJson(await this._client.get(`template:${templateId}`));
    const prevConfig = (existingRaw && existingRaw.config) || {};
    const updatedConfig = {
      ...prevConfig,
      ...configData,
      updatedAt: new Date().toISOString(),
    };
    const row = toTemplateRow(
      { templateId, config: updatedConfig },
      existingRaw || { template_id: templateId }
    );
    await this._client.set(`template:${templateId}`, JSON.stringify(row));
    return fromTemplateRow(row);
  }

  // ─── `sync_meta` table ─────────────────────────────────────────────────────

  async getSyncMeta(field) {
    await this.connect();
    const all = (await this._client.hGetAll('sync_meta')) || {};
    return all[field] || null;
  }

  async setSyncMeta(field, value) {
    await this.connect();
    await this._client.hSet('sync_meta', field, String(value));
  }

  async getAllSyncMeta() {
    await this.connect();
    return (await this._client.hGetAll('sync_meta')) || {};
  }
}

module.exports = RedisDriver;
