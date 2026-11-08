/**
 * connectService.js
 * Receptor de eventos de DocuSign Connect (webhooks).
 *
 * Por ahora SOLO guarda el payload crudo en storage (Redis). No parsea votos
 * ni toca la lógica de sync/scheduler; es un buzón de ingesta.
 *
 * Seguridad:
 *   DocuSign firma cada POST con HMAC-SHA256 en el header
 *   `X-DocuSign-Signature-1` (base64) usando un secreto que configuras en
 *   DocuSign Admin → Connect. Si DOCUSIGN_CONNECT_HMAC_KEY está definido,
 *   verificamos la firma; si no, aceptamos (modo pruebas) y lo registramos.
 */

const crypto = require('crypto');
const db = require('./databaseService');

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
 * Procesa un POST entrante de Connect: verifica HMAC (si aplica), normaliza
 * metadata mínima y guarda el evento crudo en storage.
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

  return { stored: true, verified, record };
}

module.exports = {
  verifyHmac,
  extractMetadata,
  handleConnectEvent,
};
