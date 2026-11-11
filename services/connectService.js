/**
 * connectService.js
 * Receptor de eventos de DocuSign Connect (webhooks).
 *
 * Guarda el payload crudo y actualiza el sobre normalizado (conteo de votos,
 * quórum de mayoría) en storage. Es la única fuente de actualización de sobres.
 *
 * Seguridad:
 *   DocuSign firma cada POST con HMAC-SHA256 en el header
 *   `X-DocuSign-Signature-1` (base64) usando un secreto que configuras en
 *   DocuSign Admin → Connect. Si DOCUSIGN_CONNECT_HMAC_KEY está definido,
 *   verificamos la firma; si no, aceptamos (modo pruebas) y lo registramos.
 */

const crypto = require('crypto');
const db = require('./databaseService');
const ds = require('./docusignService');
const parser = require('./docusignParser');
const emailService = require('./emailService');
const scheduler = require('./schedulerService');
const config = require('../config');

/**
 * Verifica la firma HMAC de un POST de Connect.
 *
 * @param {Buffer|string} rawBody - El cuerpo EXACTO recibido (sin re-serializar).
 * @param {string|string[]} signatureHeader - Valor de X-DocuSign-Signature-1.
 * @param {string} secret - Secreto HMAC configurado en Connect.
 * @returns {boolean} true si alguna firma coincide.
 */
function verifyHmac(rawBody, signatureHeader, secret) {
  if (!secret) return true; // Sin secreto configurado → no se exige firma.
  if (!signatureHeader) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const computed = crypto.createHmac('sha256', secret).update(body).digest('base64');
  const computedBuf = Buffer.from(computed);

  // DocuSign puede enviar varias firmas (X-DocuSign-Signature-1..N); aceptamos
  // si cualquiera coincide. El header puede llegar como string o array.
  const candidates = Array.isArray(signatureHeader) ? signatureHeader : [signatureHeader];
  for (const candidate of candidates) {
    for (const part of String(candidate).split(',')) {
      const provided = Buffer.from(part.trim());
      if (provided.length === computedBuf.length &&
          crypto.timingSafeEqual(provided, computedBuf)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Extrae metadata mínima (envelopeId, evento, status) de un payload de Connect,
 * soportando tanto el formato JSON moderno (Connect 2.0 "Aggregate") como
 * variantes simples. No falla si la forma es inesperada: devuelve lo que pueda.
 *
 * @param {object|null} parsed - Payload ya parseado como objeto, o null si no es JSON.
 * @returns {{ envelopeId: string|null, event: string|null, status: string|null }}
 */
function extractMetadata(parsed) {
  const result = { envelopeId: null, event: null, status: null };
  if (!parsed || typeof parsed !== 'object') return result;

  // Connect 2.0 (Aggregate / "JSON SIM"): { event, data: { envelopeId, envelopeSummary: { status } } }
  result.event = parsed.event || parsed.eventType || null;

  const data = parsed.data || {};
  result.envelopeId =
    data.envelopeId ||
    parsed.envelopeId ||
    (parsed.envelopeSummary && parsed.envelopeSummary.envelopeId) ||
    (data.envelopeSummary && data.envelopeSummary.envelopeId) ||
    null;

  result.status =
    (data.envelopeSummary && data.envelopeSummary.status) ||
    (parsed.envelopeSummary && parsed.envelopeSummary.status) ||
    parsed.status ||
    data.status ||
    null;

  return result;
}

/**
 * Procesa el `envelopeSummary` de un evento de DocuSign Connect para actualizar
 * el sobre normalizado y los conteos de votos en la base de datos.
 */
async function processConnectEnvelope(parsed, meta) {
  if (!parsed || typeof parsed !== 'object' || !meta.envelopeId) return null;

  const data = parsed.data || {};
  let summary = data.envelopeSummary || parsed.envelopeSummary || data || parsed;
  let recipients = summary.recipients || data.recipients || parsed.recipients || null;
  let documents = {
    envelopeDocuments: summary.envelopeDocuments || data.envelopeDocuments || [],
  };
  let docGenFormFields = summary.docGenFormFields
    ? { docGenFormFields: summary.docGenFormFields }
    : null;

  const incomingStatus = meta.status || summary.status || 'sent';

  // If the Connect webhook payload didn't embed recipient tabs (and the envelope isn't already voided),
  // fetch the single envelope's details by envelopeId so we always have complete voting tabs.
  if ((!recipients || !parser.hasCheckboxes(recipients)) && incomingStatus !== 'voided') {
    try {
      const accessToken = await ds.getAccessToken(config.docusign);
      const { accountId, baseUri } = await ds.getAccountInfo(accessToken, config.docusign);
      const [fetchedEnv, fetchedRecips, fetchedDocs, fetchedDocGen] = await Promise.all([
        ds.getEnvelope(baseUri, accountId, accessToken, meta.envelopeId).catch(() => null),
        ds.getEnvelopeRecipientsWithTabs(baseUri, accountId, accessToken, meta.envelopeId).catch(() => null),
        ds.getEnvelopeDocuments(baseUri, accountId, accessToken, meta.envelopeId).catch(() => null),
        ds.getDocGenFormFields(baseUri, accountId, accessToken, meta.envelopeId).catch(() => null),
      ]);
      if (fetchedEnv) summary = { ...summary, ...fetchedEnv };
      if (fetchedRecips) recipients = fetchedRecips;
      if (fetchedDocs) documents = fetchedDocs;
      if (fetchedDocGen) docGenFormFields = fetchedDocGen;
    } catch (fetchErr) {
      console.warn(`⚠️  [Connect] Could not fetch details for ${meta.envelopeId}: ${fetchErr.message}`);
    }
  }

  // Handle voided envelopes even when DocuSign strips tabs post-void
  if (!recipients || !parser.hasCheckboxes(recipients)) {
    if (incomingStatus === 'voided') {
      const existingEnv = await db.getEnvelope(meta.envelopeId);
      if (existingEnv) {
        if (existingEnv.status !== 'closed' && existingEnv.status !== 'completed') {
          existingEnv.status = 'voided';
          await db.saveEnvelope(meta.envelopeId, existingEnv);
        }
        await db.removeActivePresentacion(meta.envelopeId);
        return existingEnv;
      }
    }
    return null;
  }

  const storedTemplates = await db.getAllTemplates().catch(() => []);

  const envelopeMeta = {
    envelopeId: meta.envelopeId,
    templateId: summary.templateId || data.templateId || null,
    emailSubject: summary.emailSubject || parsed.emailSubject || '',
    status: incomingStatus,
    createdDateTime: summary.createdDateTime || parsed.createdDateTime || new Date().toISOString(),
    statusChangedDateTime: summary.statusChangedDateTime || new Date().toISOString(),
    expireDateTime: summary.expireDateTime || null,
    expireAfter: summary.expireAfter || null,
  };

  const normalized = parser.buildNormalizedEnvelope(
    envelopeMeta,
    recipients,
    documents,
    docGenFormFields,
    storedTemplates
  );

  // Respect Admin template config: skip envelopes whose template is set to "Rastrear: No"
  if (normalized.trackingDisabled) {
    console.log(`⏭️  [Connect] Skipping envelope ${normalized.envelopeId} (template "${normalized.templateType}" has tracking disabled).`);
    await db.removeActivePresentacion(normalized.envelopeId);
    return null;
  }

  // Preserve historical vote data when an envelope is voided
  if (normalized.status === 'voided') {
    const existingEnv = await db.getEnvelope(normalized.envelopeId);
    if (existingEnv) {
      Object.assign(normalized, {
        status: existingEnv.status === 'closed' || existingEnv.status === 'completed' ? existingEnv.status : 'voided',
        closedAt: existingEnv.closedAt || null,
        totals: existingEnv.totals,
        recipients: existingEnv.recipients,
        availableChoices: existingEnv.availableChoices,
        templateFields: existingEnv.templateFields,
        totalVoters: existingEnv.totalVoters,
        votedCount: existingEnv.votedCount,
        noVoteCount: existingEnv.noVoteCount,
        quorumThreshold: existingEnv.quorumThreshold,
        hasQuorum: existingEnv.hasQuorum,
      });
    }
  }

  // Send vote report if transitioning to 'completed'
  if (normalized.status === 'completed') {
    const existingEnv = await db.getEnvelope(normalized.envelopeId);
    const wasCompleted = existingEnv && (existingEnv.status === 'completed' || existingEnv.status === 'closed');
    if (!wasCompleted) {
      console.log(`🎉 [Connect] Envelope ${normalized.envelopeId} completed — sending report...`);
      try {
        await emailService.sendVoteReport(normalized, 'completed');
      } catch (err) {
        console.error(`Email failed for completed ${normalized.envelopeId}:`, err.message);
      }
    }
  }

  await db.saveEnvelope(normalized.envelopeId, normalized);

  const isOpen = normalized.status === 'sent' || normalized.status === 'delivered';
  if (isOpen) {
    // 1. Majority Quorum Rule (floor(totalVoters / 2) + 1): close envelope immediately
    if (normalized.hasQuorum) {
      console.log(
        `🗳️  [Connect] Envelope ${normalized.envelopeId} reached majority quorum ` +
        `(${normalized.votedCount}/${normalized.totalVoters}, need ${normalized.quorumThreshold}). Closing envelope.`
      );
      try {
        return await scheduler.closeEnvelope(normalized, 'quorum');
      } catch (err) {
        console.error(`Quorum close failed for ${normalized.envelopeId}:`, err.message);
      }
    } else if (normalized.expiresAt) {
      // 2. Track active deadline for timer expiration voiding
      await db.addActivePresentacion(normalized.envelopeId);
    }
  } else {
    await db.removeActivePresentacion(normalized.envelopeId);
  }

  return normalized;
}

/**
 * Procesa un POST entrante de Connect: verifica HMAC (si aplica), normaliza
 * metadata mínima, guarda el evento crudo y actualiza el sobre en storage.
 *
 * @param {object} args
 * @param {Buffer|string} args.rawBody - Cuerpo exacto recibido.
 * @param {object} args.headers - Headers de la petición.
 * @returns {Promise<{ stored: boolean, verified: boolean, record?: object, reason?: string }>}
 */
async function handleConnectEvent({ rawBody, headers = {} }) {
  const secret = process.env.DOCUSIGN_CONNECT_HMAC_KEY || '';
  const signature =
    headers['x-docusign-signature-1'] ||
    headers['X-DocuSign-Signature-1'] ||
    null;

  const verified = verifyHmac(rawBody, signature, secret);
  if (secret && !verified) {
    return { stored: false, verified: false, reason: 'invalid_signature' };
  }

  // Intentar parsear como JSON para extraer metadata; si falla, guardamos el raw igual.
  const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  let parsed = null;
  try {
    parsed = JSON.parse(bodyString);
  } catch {
    parsed = null; // Payload XML/legacy u otro formato: se preserva crudo.
  }

  const meta = extractMetadata(parsed);

  const record = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    envelopeId: meta.envelopeId,
    event: meta.event,
    status: meta.status,
    signatureVerified: verified,
    contentType: headers['content-type'] || headers['Content-Type'] || null,
    raw: bodyString,
  };

  await db.saveConnectEvent(record);
  console.log(
    `📥 Connect event almacenado: id=${record.id} event=${record.event || 'n/a'} ` +
    `envelope=${record.envelopeId || 'n/a'} status=${record.status || 'n/a'} verified=${verified}`
  );

  try {
    await processConnectEnvelope(parsed, meta);
  } catch (err) {
    console.error(`⚠️  [Connect] Error procesando sobre ${meta.envelopeId || 'n/a'}:`, err.message);
  }

  return { stored: true, verified, record };
}

module.exports = {
  verifyHmac,
  extractMetadata,
  handleConnectEvent,
};
