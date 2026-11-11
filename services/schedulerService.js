const db           = require('./databaseService');
const emailService = require('./emailService');
const docusign     = require('./docusignService');
const parser       = require('./docusignParser');
const config       = require('../config');

// Interval between scheduler ticks (ms).
// Dev: 60s (1 min), Prod: 900s (15 min). Override with SCHEDULER_TICK_MS.
const isProd = process.env.NODE_ENV === 'production';
const DEFAULT_TICK = isProd ? 900000 : 60000;
const TICK_MS = parseInt(process.env.SCHEDULER_TICK_MS || String(DEFAULT_TICK), 10);

class SchedulerService {
  constructor() {
    this._timer = null;
  }

  start() {
    console.log(`⏰ Scheduler started — checking every ${TICK_MS / 1000}s for expired Presentaciones`);
    this.tick();
    this._timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      console.log('⏰ Scheduler stopped');
    }
  }

  async tick() {
    try {
      const active = await db.getActivePresentaciones();
      const now = new Date();

      for (const envelope of active) {
        if (!envelope.expiresAt) continue;
        const expiresAt = new Date(envelope.expiresAt);

        if (now >= expiresAt) {
          console.log(`🚨 Envelope ${envelope.envelopeId} expired at ${expiresAt.toISOString()}. Closing…`);
          await this.closeEnvelope(envelope, 'scheduler');
        }
      }
    } catch (err) {
      console.error('Scheduler tick error:', err.message);
    }
  }

  async closeEnvelope(envelope, source = 'manual') {
    const closedAt = new Date().toISOString();

    // 'quorum' closes mark the envelope complete WITHOUT voiding it in DocuSign.
    // 'manual' and 'scheduler'/'expired' closes still void to block further voting.
    const completeOnly = source === 'quorum';

    // Find the correct environment config for this envelope
    const envConfig = config.docusign;

    // Start from the snapshot we were handed; may be refreshed below.
    let latest = envelope;

    // ── Quorum close: no void, just persist + complete locally ──────────────
    if (completeOnly) {
      console.log(`🏁 Envelope ${envelope.envelopeId} reached majority quorum — closing locally without voiding.`);
    } else {
      // ── Void close (manual / expired): CAPTURE VOTES BEFORE VOIDING ───────
      // DocuSign drops template/tab data once an envelope is voided, so we must
      // pull the freshest vote data and persist it BEFORE issuing the void.
      // Ordering is critical: fetch → save → void. If the void fails, the
      // latest votes are already safely in storage.
      if (!envConfig) {
        console.error(`⚠️ No environment configuration found — cannot void ${envelope.envelopeId}. Closing locally with cached votes.`);
      } else {
        try {
          const accessToken = await docusign.getAccessToken(envConfig);
          const account     = await docusign.getAccountInfo(accessToken, envConfig);

          // 1. Capture the latest votes from DocuSign while data is still available.
          try {
            const fresh = await this._captureLatestVotes(
              accessToken, account.baseUri, account.accountId, envelope
            );
            if (fresh) {
              latest = fresh;
              // Persist the freshest snapshot BEFORE the irreversible void.
              await db.saveEnvelope(latest.envelopeId, latest);
              console.log(`💾 Saved latest votes for ${latest.envelopeId} before voiding.`);
            }
          } catch (captureErr) {
            console.error(`⚠️ Could not refresh votes before voiding ${envelope.envelopeId}; using cached snapshot: ${captureErr.message}`);
            // Ensure the cached snapshot is persisted regardless.
            await db.saveEnvelope(latest.envelopeId, latest);
          }

          // 2. Now void in DocuSign so no one else can vote.
          const voidReason  = source === 'manual'
            ? 'Cerrado manualmente por administrador'
            : 'El tiempo límite para votar ha expirado';

          await docusign.voidEnvelope(
            accessToken,
            account.baseUri,
            account.accountId,
            envelope.envelopeId,
            voidReason
          );
          console.log(`🔒 Successfully voided envelope ${envelope.envelopeId} in DocuSign`);
        } catch (err) {
          console.error(`⚠️ Failed to void envelope in DocuSign, proceeding with local close: ${err.message}`);
        }
      }
    }

    const updated = {
      ...latest,
      status: completeOnly ? 'completed' : 'closed',
      closedAt,
    };

    await db.saveEnvelope(updated.envelopeId, updated);
    await db.removeActivePresentacion(updated.envelopeId);

    console.log(`✅ Envelope ${updated.envelopeId} closed (${source}) at ${closedAt}`);

    try {
      const reasonMap = { manual: 'manual', quorum: 'completed' };
      const reason = reasonMap[source] || 'expired';
      await emailService.sendVoteReport(updated, reason);
    } catch (err) {
      console.error(`Email failed after close of ${updated.envelopeId}:`, err.message);
    }

    return updated;
  }

  /**
   * Fetches the freshest recipient/vote data for an envelope from DocuSign and
   * returns a normalized snapshot. Merges non-vote metadata (contentText,
   * horaFinalVoto, expiresAt) from the cached snapshot when DocuSign omits it.
   *
   * Returns null if DocuSign no longer exposes valid vote data (e.g. already
   * voided) so the caller keeps the cached snapshot instead of overwriting it.
   */
  async _captureLatestVotes(accessToken, baseUri, accountId, cached) {
    const envelopeId = cached.envelopeId;

    const [envMeta, recipients, documents, docGenFormFields, storedTemplates] = await Promise.all([
      docusign.getEnvelope(baseUri, accountId, accessToken, envelopeId).catch(() => null),
      docusign.getEnvelopeRecipientsWithTabs(baseUri, accountId, accessToken, envelopeId),
      docusign.getEnvelopeDocuments(baseUri, accountId, accessToken, envelopeId),
      docusign.getDocGenFormFields(baseUri, accountId, accessToken, envelopeId),
      db.getAllTemplates().catch(() => []),
    ]);

    // If DocuSign no longer reports valid checkboxes/radios (already voided / stripped),
    // keep the cached snapshot — do not clobber saved votes with empty data.
    if (!parser.hasCheckboxes(recipients)) {
      return null;
    }

    // Minimal envelope metadata fallback when lookup misses.
    const envForParse = envMeta || {
      envelopeId,
      emailSubject: cached.subject,
      status: cached.status,
      createdDateTime: cached.createdDateTime,
      statusChangedDateTime: cached.lastModified,
    };

    const normalized = parser.buildNormalizedEnvelope(
      envForParse, recipients, documents, docGenFormFields, storedTemplates
    );

    // Preserve non-vote metadata from cache if DocuSign omitted it post-send.
    if (!normalized.contentText && cached.contentText) normalized.contentText = cached.contentText;
    if (!normalized.horaFinalVoto && cached.horaFinalVoto) normalized.horaFinalVoto = cached.horaFinalVoto;
    if (!normalized.expiresAt && cached.expiresAt) normalized.expiresAt = cached.expiresAt;

    return normalized;
  }
}

module.exports = new SchedulerService();
