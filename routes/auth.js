const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const router = express.Router();
const SESSION_COOKIE = 'dvc_session';
const STATE_COOKIE = 'dvc_oauth_state';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours
const STATE_TTL_SECONDS = 10 * 60; // 10 minutes

function parseCookies(cookieHeader = '') {
  const cookies = {};
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

function getRedirectUri(req) {
  if (config.auth.redirectUri) {
    return config.auth.redirectUri;
  }
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000').split(',')[0].trim();
  return `${proto}://${host}/auth/callback`;
}

function verifySessionCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, config.auth.sessionSecret);
  } catch {
    return null;
  }
}

/**
 * GET /auth/me — Returns current SSO authentication state
 */
router.get('/me', (req, res) => {
  const user = verifySessionCookie(req);
  if (user) {
    return res.json({
      authenticated: true,
      ssoEnabled: config.auth.ssoEnabled,
      user: {
        name: user.name,
        email: user.email,
        accountId: user.accountId,
      },
    });
  }

  return res.json({
    authenticated: !config.auth.ssoEnabled,
    ssoEnabled: config.auth.ssoEnabled,
    loginUrl: '/auth/login',
    redirectUri: getRedirectUri(req),
  });
});

/**
 * GET /auth/login — Redirects user to DocuSign OAuth 2.0 / SSO login
 */
router.get('/login', (req, res) => {
  const { integrationKey, authServer } = config.docusign;
  if (!integrationKey) {
    return res.status(500).send('Missing DOCUSIGN_INTEGRATION_KEY for SSO.');
  }

  const authHost = authServer.replace(/^https?:\/\//i, '');
  const redirectUri = getRedirectUri(req);
  const state = crypto.randomBytes(16).toString('hex');

  // Bind the OAuth state to this browser (validated in /auth/callback) to prevent login CSRF.
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    maxAge: STATE_TTL_SECONDS * 1000,
    path: '/auth',
  });

  const authUrl = new URL(`https://${authHost}/oauth/auth`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'signature');
  authUrl.searchParams.set('client_id', integrationKey);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);

  console.log(`🔑 [SSO] Redirecting to DocuSign OAuth (redirect_uri: ${redirectUri})`);
  return res.redirect(authUrl.toString());
});

/**
 * GET /auth/callback — OAuth 2.0 callback from DocuSign
 */
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const expectedState = parseCookies(req.headers.cookie)[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: '/auth' });

  if (!state || !expectedState || String(state) !== expectedState) {
    console.warn('⚠️  [SSO] OAuth state mismatch — rejecting callback');
    return res.redirect('/?auth_error=invalid_state');
  }

  if (error) {
    console.error(`❌ [SSO] OAuth callback error: ${error} - ${error_description || ''}`);
    return res.redirect(`/?auth_error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return res.redirect('/?auth_error=missing_code');
  }

  const { integrationKey, secretKey, authServer, accountId: expectedAccountId } = config.docusign;
  if (!integrationKey || !secretKey) {
    console.error('❌ [SSO] Missing DOCUSIGN_INTEGRATION_KEY or DOCUSIGN_SECRET_KEY');
    return res.redirect('/?auth_error=sso_not_configured');
  }

  const authHost = authServer.replace(/^https?:\/\//i, '');
  const redirectUri = getRedirectUri(req);
  const basicCredentials = Buffer.from(`${integrationKey}:${secretKey}`).toString('base64');

  try {
    // 1. Exchange authorization code for access token
    const tokenResp = await fetch(`https://${authHost}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicCredentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenData.access_token) {
      console.error('❌ [SSO] Token exchange failed:', tokenData);
      return res.redirect(
        `/?auth_error=${encodeURIComponent(tokenData.error_description || tokenData.error || 'token_exchange_failed')}`
      );
    }

    // 2. Fetch DocuSign user profile & accounts
    const userResp = await fetch(`https://${authHost}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userResp.json().catch(() => ({}));
    if (!userResp.ok) {
      console.error('❌ [SSO] Failed to fetch userinfo:', userInfo);
      return res.redirect('/?auth_error=userinfo_failed');
    }

    const accounts = Array.isArray(userInfo.accounts) ? userInfo.accounts : [];
    const matchedAccount = expectedAccountId
      ? accounts.find(a => a.account_id === expectedAccountId)
      : accounts[0];

    if (expectedAccountId && !matchedAccount) {
      console.warn(`⚠️  [SSO] User ${userInfo.email} does not belong to account ${expectedAccountId}`);
      return res.redirect('/?auth_error=unauthorized_account');
    }

    // Optional email allowlist check
    if (process.env.SSO_ALLOWED_EMAILS) {
      const allowed = process.env.SSO_ALLOWED_EMAILS.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      if (allowed.length > 0 && !allowed.includes(String(userInfo.email || '').toLowerCase())) {
        console.warn(`⚠️  [SSO] User ${userInfo.email} not in SSO_ALLOWED_EMAILS`);
        return res.redirect('/?auth_error=unauthorized_email');
      }
    }

    // 3. Issue signed HTTP-only session cookie
    const sessionPayload = {
      sub: userInfo.sub,
      name: userInfo.name || userInfo.email || 'Usuario DocuSign',
      email: userInfo.email || '',
      accountId: matchedAccount ? matchedAccount.account_id : null,
    };

    const sessionToken = jwt.sign(sessionPayload, config.auth.sessionSecret, {
      expiresIn: SESSION_TTL_SECONDS,
    });

    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: '/',
    });

    console.log(`✅ [SSO] User authenticated: ${sessionPayload.email} (${sessionPayload.name})`);
    return res.redirect('/');
  } catch (err) {
    console.error('❌ [SSO] Callback exception:', err.stack || err.message);
    return res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

/**
 * GET / POST /auth/logout — Clears SSO session cookie
 */
function handleLogout(_req, res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  return res.redirect('/');
}

router.get('/logout', handleLogout);
router.post('/logout', handleLogout);

module.exports = {
  authRouter: router,
  verifySessionCookie,
};
