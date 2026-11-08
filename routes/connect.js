const express = require('express');
const db = require('../services/databaseService');
const connectService = require('../services/connectService');
const scheduler = require('../services/schedulerService');

// Captura el cuerpo EXACTO (sin parsear) para poder verificar el HMAC.
// Aceptamos cualquier content-type: Connect puede mandar JSON o XML.
const rawBody = express.raw({ type: '*/*', limit: '10mb' });

// ─── Router PÚBLICO (sin Basic Auth): solo el webhook entrante ──────────────
const webhookRouter = express.Router();

/**
 * POST /connect
 * Endpoint único de DocuSign Connect. Recibe eventos de creación de sobres y
 * de firma, verifica HMAC (si hay secreto) y guarda el payload crudo.
 *
 * Responde 200 rápido para que DocuSign no reintente; cualquier
 * procesamiento posterior se hará de forma asíncrona en otra fase.
 */
webhookRouter.post('/', rawBody, async (req, res) => {
  try {
    const bodyLen = Buffer.isBuffer(req.body) ? req.body.length : String(req.body || '').length;
    console.log(
      `🔔 [POST /connect] Webhook recibido: bytes=${bodyLen} ` +
      `content-type=${req.headers['content-type'] || 'n/a'} ` +
      `hasSignature=${Boolean(req.headers['x-docusign-signature-1'] || req.headers['X-DocuSign-Signature-1'])}`
    );

    const result = await connectService.handleConnectEvent({
      rawBody: req.body, // Buffer gracias a express.raw
      headers: req.headers,
    });

    if (!result.stored && result.reason === 'invalid_signature') {
      console.warn('⚠️  [POST /connect] Connect event rechazado: firma HMAC inválida');
      return res.status(401).json({ error: 'invalid_signature' });
    }

    // Opportunistically check for any expired Presentaciones when a webhook arrives
    scheduler._tick().catch(err => console.error('⚠️  [POST /connect] scheduler tick error:', err.message));

    return res.status(200).json({
      received: true,
      id: result.record ? result.record.id : null,
      verified: result.verified,
    });
  } catch (err) {
    console.error('❌ [POST /connect] Error:', err.stack || err.message);
    // Aun en error devolvemos 200 para evitar reintentos agresivos de Connect,
    // pero dejamos traza en logs. (Se puede endurecer más adelante.)
    return res.status(200).json({ received: false, error: err.message });
  }
});

// ─── Router PROTEGIDO (detrás de Basic Auth): inspección/debug ──────────────
const adminRouter = express.Router();

/**
 * GET /connect/events — últimos eventos Connect almacenados.
 * Opcional: ?envelopeId=... para filtrar por sobre, ?limit=N.
 */
adminRouter.get('/events', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const envelopeId = req.query.envelopeId;
    const events = envelopeId
      ? await db.getConnectEventsByEnvelope(envelopeId, limit)
      : await db.getConnectEvents(limit);
    res.json({ count: events.length, events });
  } catch (err) {
    console.error('GET /connect/events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { webhookRouter, adminRouter };
