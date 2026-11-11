/**
 * services/databaseService.js
 * Database Repository Facade.
 *
 * Mirrors the relational PostgreSQL schema (`services/db/schema.sql`) across:
 *   - `templates`
 *   - `envelopes`
 *   - `connect_events`
 *   - `sync_meta`
 *
 * This is the only data-access interface the rest of the app may use. Storage
 * is selected by `DB_PROVIDER` and implemented by interchangeable drivers:
 *   - `RedisDriver` (default: Upstash REST / Redis TCP / in-memory)
 *   - `PostgresDriver` (`DB_PROVIDER=postgres` + `DATABASE_URL`/`POSTGRES_URL`)
 * Drivers share the row mappers in `services/db/models.js`.
 */

const RedisDriver = require('./db/redisDriver');
const PostgresDriver = require('./db/postgresDriver');

class DatabaseService {
  constructor() {
    this._driver = null;
  }

  _getDriver() {
    if (!this._driver) {
      const provider = (process.env.DB_PROVIDER || '').toLowerCase();
      if (provider === 'postgres' || provider === 'postgresql' || provider === 'pg') {
        this._driver = new PostgresDriver();
      } else {
        this._driver = new RedisDriver();
      }
    }
    return this._driver;
  }

  async connect() {
    await this._getDriver().connect();
  }

  getDiagnostics() {
    const driver = this._getDriver();
    return {
      provider: (process.env.DB_PROVIDER || 'redis').toLowerCase(),
      mode: driver.mode || 'uninitialized',
      envConfigured: {
        postgresUrl: Boolean(process.env.POSTGRES_URL || process.env.DATABASE_URL),
        upstashRest: Boolean(
          (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
          (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
        ),
        redisTcp: Boolean(process.env.REDIS_URL || process.env.KV_URL),
        docusignKey: Boolean(process.env.DOCUSIGN_INTEGRATION_KEY),
        docusignSecret: Boolean(process.env.DOCUSIGN_SECRET_KEY),
        docusignUser: Boolean(process.env.DOCUSIGN_USER_ID),
        docusignRsaKey: Boolean(process.env.DOCUSIGN_RSA_PRIVATE_KEY),
        connectHmac: Boolean(process.env.DOCUSIGN_CONNECT_HMAC_KEY),
      },
    };
  }

  // ─── `envelopes` repository ────────────────────────────────────────────────

  async saveEnvelope(envelopeId, data) {
    return await this._getDriver().saveEnvelope(envelopeId, data);
  }

  async getEnvelope(envelopeId) {
    return await this._getDriver().getEnvelope(envelopeId);
  }

  async getAllEnvelopes() {
    return await this._getDriver().getAllEnvelopes();
  }

  async addActivePresentacion(envelopeId) {
    return await this._getDriver().addActivePresentacion(envelopeId);
  }

  async removeActivePresentacion(envelopeId) {
    return await this._getDriver().removeActivePresentacion(envelopeId);
  }

  async getActivePresentaciones() {
    return await this._getDriver().getActivePresentaciones();
  }

  // ─── `connect_events` repository ───────────────────────────────────────────

  async saveConnectEvent(record) {
    return await this._getDriver().saveConnectEvent(record);
  }

  async getConnectEvents(limit = 50) {
    return await this._getDriver().getConnectEvents(limit);
  }

  async getConnectEventsByEnvelope(envelopeId, limit = 50) {
    return await this._getDriver().getConnectEventsByEnvelope(envelopeId, limit);
  }

  // ─── `templates` repository ────────────────────────────────────────────────

  async saveTemplate(templateId, data) {
    return await this._getDriver().saveTemplate(templateId, data);
  }

  async getTemplate(templateId) {
    return await this._getDriver().getTemplate(templateId);
  }

  async getAllTemplates() {
    return await this._getDriver().getAllTemplates();
  }

  async saveTemplateConfig(templateId, configData) {
    return await this._getDriver().saveTemplateConfig(templateId, configData);
  }

  // ─── `sync_meta` repository ────────────────────────────────────────────────

  async getSyncMeta(field) {
    return await this._getDriver().getSyncMeta(field);
  }

  async setSyncMeta(field, value) {
    return await this._getDriver().setSyncMeta(field, value);
  }

  async getAllSyncMeta() {
    return await this._getDriver().getAllSyncMeta();
  }
}

module.exports = new DatabaseService();
