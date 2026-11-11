const express = require('express');
const db           = require('../services/databaseService');
const scheduler    = require('../services/schedulerService');
const emailService = require('../services/emailService');
const parser       = require('../services/docusignParser');
const {
  syncTemplates,
  refreshSingleTemplate,
} = require('../services/syncService');

const router = express.Router();

/** GET /votes — serve all tracked envelopes stored from Connect webhooks */
router.get('/votes', async (req, res) => {
  try {
    const [rawEnvelopes, storedTemplates] = await Promise.all([
      db.getAllEnvelopes(),
      db.getAllTemplates().catch(() => []),
    ]);

    // Filter out envelopes belonging to templates configured with enabled: false ("No rastrear")
    const envelopes = rawEnvelopes.filter(env => {
      if (env.trackingDisabled) return false;
      const matched = parser.matchTemplateConfig(env, {}, storedTemplates);
      if (matched && matched.config && matched.config.enabled === false) {
        return false;
      }
      if (matched && matched.config) {
        if (matched.config.templateName) env.templateType = matched.config.templateName;
        if (Array.isArray(matched.config.voteOptions) && matched.config.voteOptions.length > 0) {
          const mergedChoices = new Set([...matched.config.voteOptions, ...(env.availableChoices || [])]);
          env.availableChoices = Array.from(mergedChoices);
        }
      }
      return true;
    });

    const overallTotals = {};
    for (const env of envelopes) {
      for (const [k, v] of Object.entries(env.totals || {})) {
        overallTotals[k] = (overallTotals[k] || 0) + v;
      }
    }

    const envString = process.env.NODE_ENV === 'production' ? 'PROD' : 'DEV';
    console.log(
      `📊 [GET /api/votes] Serving ${envelopes.length} tracked envelopes (dbMode: ${db.getDiagnostics().mode})`
    );
    res.json({
      envelopes,
      overallTotals,
      environment: envString,
      diagnostics: db.getDiagnostics(),
    });
  } catch (err) {
    console.error('❌ [GET /api/votes] error:', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /report/:envelopeId — manually resend vote result email */
router.post('/report/:envelopeId', async (req, res) => {
  try {
    const envelope = await db.getEnvelope(req.params.envelopeId);
    if (!envelope) return res.status(404).json({ error: 'Envelope not found' });

    await emailService.sendVoteReport(envelope);
    res.json({ success: true, message: 'Report email sent' });
  } catch (err) {
    console.error('POST /api/report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /close/:envelopeId — manual "Close Now" for open voting envelopes */
router.post('/close/:envelopeId', async (req, res) => {
  try {
    const envelope = await db.getEnvelope(req.params.envelopeId);
    if (!envelope) return res.status(404).json({ error: 'Envelope not found' });

    if (envelope.status === 'closed' || envelope.status === 'completed') {
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

/**
 * Helper to load templates from storage and partition into valid vs non-voting templates
 */
async function buildTemplatesPayload() {
  const allTemplates = await db.getAllTemplates();
  allTemplates.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));

  const validTemplates = allTemplates.filter(t => t.isValid);
  const invalidTemplates = allTemplates.filter(t => !t.isValid);
  const syncMeta = await db.getAllSyncMeta();

  return {
    validTemplates,
    invalidTemplates,
    syncMeta,
  };
}

/** GET /templates — serve stored templates from storage (initial sync only if never synced) */
router.get('/templates', async (req, res) => {
  try {
    let syncMeta = await db.getAllSyncMeta();
    let allTemplates = await db.getAllTemplates();
    let docusignError = null;

    if (allTemplates.length === 0 && !syncMeta.templates_last_synced_at) {
      console.log('📋 [GET /api/templates] No templates cached in storage yet — performing initial sync...');
      try {
        await syncTemplates({ full: true });
      } catch (dsErr) {
        console.error('⚠️  [GET /api/templates] Initial DocuSign template sync error:', dsErr.message);
        docusignError = dsErr.message;
      }
    }

    const payload = await buildTemplatesPayload();
    res.json({
      ...payload,
      docusignError,
    });
  } catch (err) {
    console.error('❌ [GET /api/templates] error:', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /templates/sync — incremental (by created date) or full sync of templates from DocuSign */
router.post('/templates/sync', async (req, res) => {
  try {
    const full = Boolean((req.body && req.body.full) || req.query.full === 'true');
    const syncResult = await syncTemplates({ full });
    const payload = await buildTemplatesPayload();
    res.json({
      success: true,
      syncedCount: syncResult.syncedCount,
      ...payload,
    });
  } catch (err) {
    console.error('❌ [POST /api/templates/sync] error:', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /templates/:templateId/refresh — refresh a single template from DocuSign and update storage */
router.post('/templates/:templateId/refresh', async (req, res) => {
  try {
    const template = await refreshSingleTemplate(req.params.templateId);
    const payload = await buildTemplatesPayload();
    res.json({
      success: true,
      template,
      ...payload,
    });
  } catch (err) {
    console.error(`❌ [POST /api/templates/${req.params.templateId}/refresh] error:`, err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /templates/:templateId/config — save admin config for a template in storage */
router.post('/templates/:templateId/config', async (req, res) => {
  try {
    const { templateName, voteOptions, contentField, enabled = true } = req.body || {};
    const parsedOptions = Array.isArray(voteOptions)
      ? voteOptions
      : String(voteOptions || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);

    const updated = await db.saveTemplateConfig(req.params.templateId, {
      templateName: templateName || '',
      voteOptions: parsedOptions,
      contentField: contentField || '',
      enabled: Boolean(enabled),
    });

    const payload = await buildTemplatesPayload();
    res.json({
      success: true,
      template: updated,
      ...payload,
    });
  } catch (err) {
    console.error(`❌ [POST /api/templates/${req.params.templateId}/config] error:`, err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
