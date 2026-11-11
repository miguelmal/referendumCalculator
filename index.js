const path    = require('path');
const express = require('express');
require('dotenv').config();

const scheduler    = require('./services/schedulerService');
const db           = require('./services/databaseService');
const apiRoutes    = require('./routes/api');
const { authRouter } = require('./routes/auth');
const { webhookRouter: connectWebhook, adminRouter: connectAdmin } = require('./routes/connect');
const { ssoAuthMiddleware } = require('./middleware/ssoAuth');
const config       = require('./config');

const app  = express();
const PORT = process.env.PORT || 3000;

// Behind a reverse proxy / platform edge: honour X-Forwarded-* so req.secure and cookies work.
app.set('trust proxy', true);

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
// Se monta ANTES de express.json() y del gate SSO: DocuSign no envía nuestras
// credenciales y el HMAC requiere el cuerpo crudo (el router usa express.raw).
app.use('/connect', connectWebhook);

app.use(express.json());

// Health check & diagnostics (unauthenticated)
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

// DocuSign OAuth 2.0 SSO routes & static UI assets
app.use('/auth', authRouter);
app.use(express.static(path.join(__dirname, 'public')));

// SSO gate (portal users) for the dashboard API and Connect admin endpoints
app.use(ssoAuthMiddleware);

app.use('/api', apiRoutes);
// Inspección de eventos Connect (detrás de autenticación)
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
  console.log('⚙️  Booting DocuSign Vote Counter...');

  if (config.auth.ssoEnabled) {
    if (!config.auth.sessionSecret) {
      throw new Error('SSO is enabled but neither SESSION_SECRET nor DOCUSIGN_SECRET_KEY is set.');
    }
    console.log('🔑 DocuSign OAuth 2.0 SSO enabled (portal)');
  } else {
    console.warn('⚠️  SSO is not configured — dashboard is publicly accessible');
  }

  try {
    console.log('🗄️  Connecting to database...');
    await db.connect();
  } catch (err) {
    console.error('❌ Database connection error:', err);
  }

  console.log('📡 Ready — envelopes are updated via DocuSign Connect webhooks (/connect).');
  scheduler.start();

  app.listen(PORT, () => {
    console.log(`🚀 DocuSign Vote Counter running at http://localhost:${PORT}`);
  });
}

// When imported (e.g. by a serverless adapter) the app is exported without listening.
if (require.main === module) {
  boot().catch(err => {
    console.error('❌ Fatal startup error:', err.message);
    process.exit(1);
  });
}

module.exports = app;
