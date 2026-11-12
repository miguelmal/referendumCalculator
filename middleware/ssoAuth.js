/**
 * Portal authentication middleware.
 *
 * Protects the dashboard's own endpoints (`/api/*`, `/connect/events`) with the
 * DocuSign OAuth SSO session cookie (`dvc_session`). SSO identifies portal
 * users only; all calls to the DocuSign API itself use the JWT grant signed
 * with the RSA certificate (see services/docusignService.js).
 */
const config = require('../config');
const { verifySessionCookie } = require('../routes/auth');

function ssoAuthMiddleware(req, res, next) {
  const user = verifySessionCookie(req);
  if (user) {
    req.user = user;
    return next();
  }

  if (config.auth.ssoEnabled) {
    return res.status(401).json({
      error: 'Authentication required',
      ssoEnabled: true,
      loginUrl: '/auth/login',
    });
  }

  // SSO not configured (local development): allow through. A warning is logged at boot.
  return next();
}

module.exports = { ssoAuthMiddleware };
