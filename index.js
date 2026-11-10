const path    = require('path');
const express = require('express');
require('dotenv').config();

const scheduler    = require('./services/schedulerService');
const db           = require('./services/databaseService');
const apiRoutes    = require('./routes/api');
const { webhookRouter: connectWebhook, adminRouter: connectAdmin } = require('./routes/connect');
const { basicAuthMiddleware } = require('./middleware/basicAuth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Request / Response Logger ────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  const contentType = req.headers['content-type'] || 'n/a';
  console.log(`➡️  [REQ] ${req.method} ${req.originalUrl} (content-type: ${contentType})`);

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? '❌' : res.statusCode >= 400 ? '⚠️ ' : '⬅️ ';
    console.log(`${level} [RES] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms)`);
  });

  next();
});

// ── DocuSign Connect webhook ─────────────────────────────────────────────────
// Se monta ANTES de express.json() y del Basic Auth: DocuSign no envía nuestras
// credenciales y el HMAC requiere el cuerpo crudo (el router usa express.raw).
app.use('/connect', connectWebhook);

app.use(express.json());

// Load-balancer / compose / Vercel health check & diagnostics (unauthenticated)
app.get('/health', async (_req, res) => {
  try {
    await db.connect();
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      diagnostics: db.getDiagnostics(),
    });
  } catch (err) {
    console.error('❌ [/health] DB check failed:', err.stack || err.message);
    res.status(500).json({
      status: 'error',
      error: err.message,
      diagnostics: db.getDiagnostics(),
    });
  }
});

// Temporary shared password for dashboard + API (skip if APP_BASIC_AUTH_PASSWORD unset)
app.use(basicAuthMiddleware);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRoutes);
// Inspección de eventos Connect (detrás del Basic Auth)
app.use('/connect', connectAdmin);

// ── Catch-all 404 & Error Handlers ───────────────────────────────────────────
app.use((req, res) => {
  console.warn(`⚠️  [404] Route not found: ${req.method} ${req.originalUrl} (path: ${req.path})`);
  res.status(404).json({
    error: 'Route not found',
    method: req.method,
    path: req.originalUrl,
  });
});

app.use((err, req, res, _next) => {
  console.error(`❌ [ERROR] Unhandled error on ${req.method} ${req.originalUrl}:`, err.stack || err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    path: req.originalUrl,
  });
});

// ─── Boot ──────────────────────────────────────────────────────────────────

async function boot() {
  try {
    console.log('⚙️  Booting DocuSign Vote Counter...');

    if (process.env.APP_BASIC_AUTH_PASSWORD) {
      console.log(`🔒 Basic auth enabled (user: ${process.env.APP_BASIC_AUTH_USER || 'admin'})`);
    } else {
      console.warn('⚠️  APP_BASIC_AUTH_PASSWORD not set — dashboard is publicly accessible');
    }

    console.log('🗄️  Connecting to database...');
    await db.connect();

    console.log('📡 Ready — envelopes are updated exclusively via DocuSign Connect webhooks (/connect).');

    scheduler.start();
  } catch (err) {
    console.error('❌ Startup error:', err);
    scheduler.start();
  }

  app.listen(PORT, () => {
    console.log(`🚀 DocuSign Vote Counter running at http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL && require.main === module) {
  boot();
}

module.exports = app;
