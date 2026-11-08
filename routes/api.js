const express = require('express');
const db           = require('../services/databaseService');
const scheduler    = require('../services/schedulerService');
const emailService = require('../services/emailService');
const { refreshCache } = require('../services/syncService');

const router = express.Router();

/** GET /votes — serve all envelopes from Redis */
router.get('/votes', async (req, res) => {
  try {
    const envelopes = await db.getAllEnvelopes();

    const overallTotals = {};
    for (const env of envelopes) {
      for (const [k, v] of Object.entries(env.totals || {})) {
        overallTotals[k] = (overallTotals[k] || 0) + v;
      }
    }

    const envString = process.env.NODE_ENV === 'production' ? 'PROD' : 'DEV';
    console.log(`📊 [GET /api/votes] Serving ${envelopes.length} envelopes (dbMode: ${db.getDiagnostics().mode})`);
    res.json({ envelopes, overallTotals, environment: envString, diagnostics: db.getDiagnostics() });
  } catch (err) {
    console.error('❌ [GET /api/votes] error:', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /refresh — admin trigger to re-sync from DocuSign */
router.post('/refresh', async (req, res) => {
  try {
    console.log('🔄 [POST /api/refresh] Manual sync triggered...');
    await refreshCache();
    await scheduler._tick();
    console.log('✅ [POST /api/refresh] Manual sync completed');
    res.json({ success: true, message: 'Cache refreshed from DocuSign' });
  } catch (err) {
    console.error('❌ [POST /api/refresh] error:', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

/** GET /cron — Vercel Cron endpoint to sync cache & process expired envelopes */
router.get('/cron', async (req, res) => {
  try {
    console.log('⏰ [GET /api/cron] Cron sync triggered...');
    await refreshCache();
    await scheduler._tick();
    console.log('✅ [GET /api/cron] Cron sync completed');
    res.json({ success: true, message: 'Cron sync and scheduler tick completed' });
  } catch (err) {
    console.error('❌ [GET /api/cron] error:', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /report/:envelopeId — manually resend vote result email */
router.post('/report/:envelopeId', async (req, res) => {
  try {
    const envelope = await db.getEnvelope(req.params.envelopeId);
    if (!envelope) return res.status(404).json({ error: 'Envelope not found in cache' });

    await emailService.sendVoteReport(envelope);
    res.json({ success: true, message: 'Report email sent' });
  } catch (err) {
    console.error('POST /api/report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /close/:envelopeId — manual "Close Now" for Presentacion de Casos */
router.post('/close/:envelopeId', async (req, res) => {
  try {
    const envelope = await db.getEnvelope(req.params.envelopeId);
    if (!envelope) return res.status(404).json({ error: 'Envelope not found in cache' });

    if (envelope.templateType !== 'Presentacion de Casos') {
      return res.status(400).json({ error: 'Close Now is only available for Presentacion de Casos envelopes' });
    }
    if (envelope.status === 'closed') {
      return res.status(400).json({ error: 'Envelope is already closed' });
    }
    if (envelope.status === 'voided') {
      return res.status(400).json({ error: 'Cannot close a voided envelope' });
    }

    const updated = await scheduler.closeEnvelope(envelope, 'manual');
    res.json({ success: true, message: 'Envelope closed and report sent', envelope: updated });
  } catch (err) {
    console.error('POST /api/close error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



module.exports = router;
