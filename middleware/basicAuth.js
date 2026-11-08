/**
 * Temporary shared-password gate (HTTP Basic Auth).
 * Protects dashboard + API until a real auth system is added.
 * Skip when APP_BASIC_AUTH_PASSWORD is unset (local dev convenience).
 */
const crypto = require('crypto');

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Compare against self to keep timing roughly constant
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function basicAuthMiddleware(req, res, next) {
  const expectedUser = process.env.APP_BASIC_AUTH_USER || 'admin';
  const expectedPass = process.env.APP_BASIC_AUTH_PASSWORD;

  if (!expectedPass) {
    return next();
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="DocuSign Vote Counter"');
    return res.status(401).send('Authentication required');
  }

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    res.set('WWW-Authenticate', 'Basic realm="DocuSign Vote Counter"');
    return res.status(401).send('Invalid authorization header');
  }

  const colon = decoded.indexOf(':');
  const user = colon >= 0 ? decoded.slice(0, colon) : '';
  const pass = colon >= 0 ? decoded.slice(colon + 1) : '';

  if (safeEqual(user, expectedUser) && safeEqual(pass, expectedPass)) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="DocuSign Vote Counter"');
  return res.status(401).send('Invalid credentials');
}

module.exports = { basicAuthMiddleware };
