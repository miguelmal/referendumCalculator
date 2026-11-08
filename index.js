const path    = require('path');
const express = require('express');
require('dotenv').config();

const scheduler    = require('./services/schedulerService');
const { refreshCache } = require('./services/syncService');
const db           = require('./services/databaseService');
const apiRoutes    = require('./routes/api');
const { webhookRouter: connectWebhook, adminRouter: connectAdmin } = require('./routes/connect');
const { basicAuthMiddleware } = require('./middleware/basicAuth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── DocuSign Connect webhook ─────────────────────────────────────────────────
// Se monta ANTES de express.json() y del Basic Auth: DocuSign no envía nuestras
// credenciales y el HMAC requiere el cuerpo crudo (el router usa express.raw).
app.use('/connect', connectWebhook);

app.use(express.json());

// Load-balancer / compose health check must stay unauthenticated
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Temporary shared password for dashboard + API (skip if APP_BASIC_AUTH_PASSWORD unset)
app.use(basicAuthMiddleware);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRoutes);
// Inspección de eventos Connect (detrás del Basic Auth)
app.use('/connect', connectAdmin);

// ─── Boot ──────────────────────────────────────────────────────────────────

async function boot() {
  try {
    console.log('⚙️  Booting DocuSign Vote Counter...');

    if (process.env.APP_BASIC_AUTH_PASSWORD) {
      console.log(`🔒 Basic auth enabled (user: ${process.env.APP_BASIC_AUTH_USER || 'admin'})`);
    } else {
      console.warn('⚠️  APP_BASIC_AUTH_PASSWORD not set — dashboard is publicly accessible');
    }

    console.log('🗄️  Connecting to Redis...');
    await db.connect();

    console.log('🔄 Populating cache from DocuSign...');
    await refreshCache();
    console.log('✅ Cache populated.');

    // Refresh cache every 15 minutes
    setInterval(() => {
      console.log('🔄 Scheduled sync every 15 minutes...');
      refreshCache().catch(err => console.error('❌ Scheduled sync error:', err));
    }, 15 * 60 * 1000);

    scheduler.start();
  } catch (err) {
    console.error('❌ Startup error (cache not populated):', err);
    console.error('   The dashboard will serve from an empty cache until /api/refresh succeeds.');
    // Still start the scheduler so it can retry once data is available
    scheduler.start();
  }

  app.listen(PORT, () => {
    console.log(`🚀 DocuSign Vote Counter running at http://localhost:${PORT}`);
  });
}

boot();
