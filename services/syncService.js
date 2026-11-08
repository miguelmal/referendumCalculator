const ds = require('./docusignService');
const parser = require('./docusignParser');
const db = require('./databaseService');
const emailService = require('./emailService');
const scheduler = require('./schedulerService');
const config = require('../config');

/**
 * Main synchronization routine.
 * Iterates through all configured DocuSign environments, fetches envelopes,
 * and normalizes the vote counts into Redis.
 */
async function refreshCache() {
  const { docusign: envConfig } = config;
  const fromDate = await db.getLatestEnvelopeDate();
  const envelopeStatus = '';
  
  if (!envConfig.integrationKey) {
    console.error('❌ DocuSign environment is not fully configured.');
    return;
  }

  try {
    const accessToken = await ds.getAccessToken(envConfig);
    const { accountId, baseUri } = await ds.getAccountInfo(accessToken, envConfig);

    console.log(`\n🔄 Syncing environment: DocuSign`);
    const envelopesData = await ds.listEnvelopes(
      baseUri,
      accountId,
      accessToken,
      fromDate,
      envelopeStatus
    );

    const envs = envelopesData || [];
    console.log(`   Found ${envs.length} envelopes. Syncing details...`);

    for (const env of envs) {
      if (!env.envelopeId) continue;
      
      const [recipients, documents, docGenMapResult] = await Promise.all([
        ds.getEnvelopeRecipientsWithTabs(baseUri, accountId, accessToken, env.envelopeId),
        ds.getEnvelopeDocuments(baseUri, accountId, accessToken, env.envelopeId),
        ds.getDocGenFormFields(baseUri, accountId, accessToken, env.envelopeId)
      ]);
      
      let docGenMap = docGenMapResult;

      // Only process envelopes whose template has checkboxes (voting documents)
      if (!parser.hasCheckboxes(recipients)) {
        continue;
      }
      
      const normalized = parser.buildNormalizedEnvelope(
        env, recipients, documents, docGenMap
      );
      
      // If the incoming envelope is voided, merge its status with our local historical data
      if (normalized.status === 'voided') {
         const existingEnv = await db.getEnvelope(normalized.envelopeId);
         if (existingEnv) {
            Object.assign(normalized, {
               totals: existingEnv.totals,
               recipients: existingEnv.recipients,
               availableChoices: existingEnv.availableChoices,
               templateFields: existingEnv.templateFields,
               totalVoters: existingEnv.totalVoters,
               votedCount: existingEnv.votedCount,
               noVoteCount: existingEnv.noVoteCount,
               quorumThreshold: existingEnv.quorumThreshold,
               hasQuorum: existingEnv.hasQuorum
            });
         }
      }

      // Detect transition to 'completed' — all members voted
      if (normalized.status === 'completed') {
        const existingEnv = await db.getEnvelope(normalized.envelopeId);
        const wasCompleted = existingEnv && existingEnv.status === 'completed';
        if (!wasCompleted) {
          console.log(`🎉 Envelope ${normalized.envelopeId} completed — all votes in. Sending report...`);
          try {
            await emailService.sendVoteReport(normalized, 'completed');
          } catch (err) {
            console.error(`Email failed for completed ${normalized.envelopeId}:`, err.message);
          }
        }
      }
      
      await db.saveEnvelope(normalized.envelopeId, normalized);

      // Presentacion de Casos index logic
      if (normalized.templateType === 'Presentacion de Casos' &&
          (normalized.status === 'sent' || normalized.status === 'delivered') &&
          normalized.expiresAt) {
        await db.addActivePresentacion(normalized.envelopeId);

        // ── Feature: majority-quorum close ──────────────────────────────────
        // If a simple majority (floor(n/2)+1) of eligible voters have voted,
        // close the envelope as COMPLETED without voiding it in DocuSign.
        if (normalized.hasQuorum) {
          console.log(
            `🗳️  Envelope ${normalized.envelopeId} reached quorum ` +
            `(${normalized.votedCount}/${normalized.totalVoters}, need ${normalized.quorumThreshold}). ` +
            `Completing without voiding.`
          );
          try {
            await scheduler.closeEnvelope(normalized, 'quorum');
          } catch (err) {
            console.error(`Quorum close failed for ${normalized.envelopeId}:`, err.message);
          }
          continue; // Envelope is closed; skip deadline adjustment.
        }

        // ── Feature: deadline (expiration) adjustment ───────────────────────
        // If DocuSign would expire the envelope BEFORE the configured voting
        // deadline, push the DocuSign expiration out so voting isn't cut short.
        try {
          await ensureExpirationCoversVotingDeadline(
            baseUri, accountId, accessToken, normalized
          );
        } catch (err) {
          console.error(`Deadline adjustment failed for ${normalized.envelopeId}:`, err.message);
        }
      } else {
        await db.removeActivePresentacion(normalized.envelopeId);
      }
    }
  } catch (err) {
    console.error(`❌ Error syncing:`, err);
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Ensures the DocuSign envelope expiration covers the configured voting deadline.
 *
 * DocuSign stores expiration as `notification.expirations.expireAfter`, a day
 * count measured from the envelope creation date (there is no absolute-date
 * field). If the current expiration would fire BEFORE the voting deadline
 * (`envelope.expiresAt`), we extend it via the notification API so DocuSign
 * does not expire the envelope while voting is still open.
 *
 * @param {string} baseUri
 * @param {string} accountId
 * @param {string} accessToken
 * @param {object} envelope - Normalized envelope (uses expiresAt, createdDateTime, envelopeId).
 */
async function ensureExpirationCoversVotingDeadline(baseUri, accountId, accessToken, envelope) {
  if (!envelope.expiresAt) return;

  const votingDeadline = new Date(envelope.expiresAt);
  if (isNaN(votingDeadline.getTime())) return;

  const created = new Date(envelope.createdDateTime || Date.now());
  if (isNaN(created.getTime())) return;

  // Days from creation needed to reach (and slightly exceed) the voting deadline.
  // Round up and add a 1-day buffer so DocuSign never expires early.
  const requiredDays = Math.ceil((votingDeadline.getTime() - created.getTime()) / MS_PER_DAY) + 1;
  if (requiredDays <= 0) return;

  // Read the envelope's current expiration setting.
  const notification = await ds.getEnvelopeNotification(baseUri, accountId, accessToken, envelope.envelopeId);
  const expirations = (notification && notification.expirations) || {};
  const expireEnabled = String(expirations.expireEnabled) === 'true';
  const currentExpireAfter = parseInt(expirations.expireAfter, 10);

  // The DocuSign moment the envelope would currently expire.
  const currentExpiryMs = (!isNaN(currentExpireAfter))
    ? created.getTime() + currentExpireAfter * MS_PER_DAY
    : null;

  // Only extend when expiration is unknown, or currently fires before the deadline.
  const needsExtension =
    !expireEnabled ||
    isNaN(currentExpireAfter) ||
    (currentExpiryMs !== null && currentExpiryMs < votingDeadline.getTime());

  if (!needsExtension) return;

  console.log(
    `🗓️  Extending DocuSign expiration for ${envelope.envelopeId}: ` +
    `current expireAfter=${isNaN(currentExpireAfter) ? 'n/a' : currentExpireAfter}d → ${requiredDays}d ` +
    `(voting deadline ${votingDeadline.toISOString()}).`
  );

  await ds.updateEnvelopeNotification(
    accessToken, baseUri, accountId, envelope.envelopeId, requiredDays
  );
}

module.exports = {
  refreshCache
};
