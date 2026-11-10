const ds = require('./docusignService');
const parser = require('./docusignParser');
const db = require('./databaseService');
const config = require('../config');

/**
 * Normalizes a raw DocuSign template + its recipients/tabs into our storage model.
 */
function buildNormalizedTemplate(rawTemplate, recipients) {
  const tabInfo = parser.inspectTemplateTabs(recipients || {});
  return {
    templateId: rawTemplate.templateId,
    name: rawTemplate.name || '(Sin nombre)',
    description: rawTemplate.description || '',
    shared: rawTemplate.shared === 'true' || rawTemplate.shared === true,
    folderName: rawTemplate.folderName || '',
    created: rawTemplate.created || null,
    lastModified: rawTemplate.lastModified || null,
    lastSyncedAt: new Date().toISOString(),
    ...tabInfo,
  };
}

/**
 * Syncs templates from DocuSign into storage.
 * Uses `sync_meta.templates_last_created_at` for incremental `from_date` queries
 * unless `full: true` is passed.
 */
async function syncTemplates({ full = false } = {}) {
  const { docusign: envConfig } = config;
  if (!envConfig.integrationKey) {
    throw new Error('DocuSign environment is not fully configured (missing DOCUSIGN_INTEGRATION_KEY).');
  }

  const fromDate = full ? null : await db.getSyncMeta('templates_last_created_at');
  console.log(`📋 [SyncTemplates] Syncing templates from DocuSign (fromDate: ${fromDate || 'ALL'})...`);

  const accessToken = await ds.getAccessToken(envConfig);
  const { accountId, baseUri } = await ds.getAccountInfo(accessToken, envConfig);

  const rawTemplates = await ds.listTemplates(baseUri, accountId, accessToken, fromDate, 'created');
  const validList = (rawTemplates || []).filter(t => t && t.templateId);
  console.log(`   Found ${validList.length} templates from DocuSign. Inspecting tabs...`);

  const CONCURRENCY = 5;
  for (let i = 0; i < validList.length; i += CONCURRENCY) {
    const batch = validList.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (t) => {
      let recipients = {};
      try {
        recipients = await ds.getTemplateRecipientsWithTabs(baseUri, accountId, accessToken, t.templateId);
      } catch (err) {
        console.warn(`⚠️  Could not fetch tabs for template ${t.templateId} (${t.name}): ${err.message}`);
      }
      const normalized = buildNormalizedTemplate(t, recipients);
      await db.saveTemplate(t.templateId, normalized);
    }));
  }

  // Update the sync watermark based on the newest template `created` timestamp
  const allStored = await db.getAllTemplates();
  let maxCreated = null;
  for (const tmpl of allStored) {
    if (!tmpl.created) continue;
    const d = new Date(tmpl.created);
    if (!isNaN(d.getTime()) && (!maxCreated || d > maxCreated)) {
      maxCreated = d;
    }
  }

  if (maxCreated) {
    await db.setSyncMeta('templates_last_created_at', maxCreated.toISOString());
  }
  await db.setSyncMeta('templates_last_synced_at', new Date().toISOString());

  return {
    syncedCount: validList.length,
    totalStored: allStored.length,
    syncMeta: await db.getAllSyncMeta(),
  };
}

/**
 * Refreshes a single template by ID from DocuSign and updates its record in storage.
 */
async function refreshSingleTemplate(templateId) {
  const { docusign: envConfig } = config;
  if (!envConfig.integrationKey) {
    throw new Error('DocuSign environment is not fully configured (missing DOCUSIGN_INTEGRATION_KEY).');
  }

  console.log(`🔄 [RefreshTemplate] Refreshing single template ${templateId} from DocuSign...`);
  const accessToken = await ds.getAccessToken(envConfig);
  const { accountId, baseUri } = await ds.getAccountInfo(accessToken, envConfig);

  const [details, recipients] = await Promise.all([
    ds.getTemplateDetails(baseUri, accountId, accessToken, templateId),
    ds.getTemplateRecipientsWithTabs(baseUri, accountId, accessToken, templateId).catch(() => ({})),
  ]);

  const normalized = buildNormalizedTemplate(details, recipients);
  const saved = await db.saveTemplate(templateId, normalized);
  return saved;
}

module.exports = {
  syncTemplates,
  refreshSingleTemplate,
};
