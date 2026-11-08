const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('./databaseService');

async function loggedFetch(url, options = {}) {
  const method = options.method || 'GET';
  const requestPayload = options.body ? options.body : null;
  const startTime = Date.now();
  
  let response;
  let statusCode = 500;
  let responseText = null;
  
  try {
    response = await fetch(url, options);
    statusCode = response.status;
    responseText = await response.text();
    return new Response(responseText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  } catch (err) {
    responseText = err.message;
    throw err;
  } finally {
    const durationMs = Date.now() - startTime;
    let reqJson = requestPayload;
    if (typeof reqJson === 'string') {
      try { reqJson = JSON.parse(reqJson); } catch(e) {}
    }
    let resJson = responseText;
    if (typeof resJson === 'string') {
      try { resJson = JSON.parse(resJson); } catch(e) {}
    }
    
    // Log asynchronously
    const endpoint = (typeof url === 'object' ? url.toString() : url).split('?')[0];
    db.logApiCall(endpoint, method, reqJson ? JSON.stringify(reqJson) : null, resJson ? JSON.stringify(resJson) : null, statusCode, durationMs).catch(() => {});
  }
}

async function safeJson(response, contextMessage) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${contextMessage}. Expected JSON but got: ${text.slice(0, 150)}...`);
  }
}

/**
 * Requests an Access Token using DocuSign JWT OAuth Flow
 */
async function getAccessToken(envConfig) {
  if (!envConfig.integrationKey || !envConfig.userId) {
    throw new Error(
      `Missing JWT Authentication details!\n` +
      `Verify DOCUSIGN_INTEGRATION_KEY and DOCUSIGN_USER_ID in your environment.`
    );
  }

  let privateKey =
    envConfig.privateKey ||
    process.env.DOCUSIGN_RSA_PRIVATE_KEY ||
    process.env.DOCUSIGN_PRIVATE_KEY ||
    null;
  if (privateKey) {
    // Strip optional wrapping quotes and convert literal \n sequences to newlines
    privateKey = privateKey.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').trim();
  } else {
    const privateKeyPath = path.resolve(envConfig.privateKeyPath || 'dev.pem');
    if (!fs.existsSync(privateKeyPath)) {
      throw new Error(
        `Missing DocuSign RSA private key. Set DOCUSIGN_RSA_PRIVATE_KEY or place a PEM at: ${privateKeyPath}`
      );
    }
    try {
      privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    } catch (err) {
      throw new Error(`Failed to read private.pem key file: ${err.message}`);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const jwtPayload = {
    iss: envConfig.integrationKey,
    sub: envConfig.userId,
    iat: now,
    exp: now + 3600,
    aud: envConfig.authServer.replace(/^https?:\/\//i, ''),
    scope: 'signature impersonation'
  };

  const assertion = jwt.sign(jwtPayload, privateKey, { algorithm: 'RS256' });

  const authHost = envConfig.authServer.replace(/^https?:\/\//i, '');
  const response = await loggedFetch(`https://${authHost}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: assertion
    })
  });

  const data = await safeJson(response, "DocuSign API Error");

  if (!response.ok) {
    if (data.error === 'consent_required') {
      const consentUrl = `https://${authHost}/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=${envConfig.integrationKey}&redirect_uri=https://localhost`;
      throw new Error(
        `\n⚠️ User Consent Required for env ${envConfig.name}!\n\nPlease open the link below in your web browser to grant consent, and then run this program again:\n\n${consentUrl}\n`
      );
    }
    throw new Error(`DocuSign JWT token assertion failed for env ${envConfig.name}: ${data.error_description || data.error || response.statusText}`);
  }

  return data.access_token;
}

/**
 * Gets the account Base URI
 */
async function getAccountInfo(accessToken, envConfig) {
  const authHost = envConfig.authServer.replace(/^https?:\/\//i, '');
  const response = await loggedFetch(`https://${authHost}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to get user info for env ${envConfig.name}: ${response.statusText}`);
  }

  const data = await safeJson(response, "DocuSign API Error");
  const account = data.accounts.find(a => a.account_id === envConfig.accountId) || data.accounts[0];

  return {
    accountId: account.account_id,
    baseUri: account.base_uri
  };
}

/**
 * Lists envelopes updated since fromDate
 */
async function listEnvelopes(baseUri, accountId, accessToken, fromDate, status = 'completed') {
  const url = new URL(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes`);
  url.searchParams.append('from_date', fromDate);
  url.searchParams.append('status', status);

  const response = await loggedFetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to list envelopes: ${response.statusText}`);
  }

  const data = await safeJson(response, "DocuSign API Error");
  return data.envelopes || [];
}

/**
 * Fetches routing/recipient details (with tabs) for an envelope
 */
async function getEnvelopeRecipientsWithTabs(baseUri, accountId, accessToken, envelopeId) {
  const url = `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/recipients?include_tabs=true`;
  const response = await loggedFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch recipients for ${envelopeId}: ${response.statusText}`);
  }

  return await safeJson(response, "DocuSign API Error");
}

/**
 * Fetches document metadata
 */
async function getEnvelopeDocuments(baseUri, accountId, accessToken, envelopeId) {
  const url = `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/documents`;
  const response = await loggedFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch documents for ${envelopeId}: ${response.statusText}`);
  }

  return await safeJson(response, "DocuSign API Error");
}

/**
 * Voids an envelope in DocuSign.
 */
async function voidEnvelope(accessToken, baseUri, accountId, envelopeId, voidReason) {
  const url = `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}`;
  const response = await loggedFetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      status: 'voided',
      voidedReason: voidReason
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to void envelope: ${response.statusText} (${response.status}) - ${text}`);
  }

  return await safeJson(response, "DocuSign API Error");
}

/**
 * Fetches the notification (reminders + expiration) settings for an envelope.
 * Returns the raw notification object, e.g.
 *   { useAccountDefaults, reminders: {...}, expirations: { expireEnabled, expireAfter, expireWarn } }
 */
async function getEnvelopeNotification(baseUri, accountId, accessToken, envelopeId) {
  const url = `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/notification`;
  const response = await loggedFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    // Not all envelopes expose notification settings; treat as "unknown".
    return null;
  }

  return await safeJson(response, "DocuSign API Error");
}

/**
 * Updates the notification (expiration) settings for an envelope.
 *
 * DocuSign expiration is relative to envelope creation and expressed in days
 * via expirations.expireAfter. There is no absolute date field, so callers
 * must compute the day count from the envelope creation date.
 *
 * @param {number} expireAfterDays - Days from creation until expiration.
 * @param {number} [expireWarnDays=0] - Days before expiration to warn (0 = no warning).
 */
async function updateEnvelopeNotification(
  accessToken,
  baseUri,
  accountId,
  envelopeId,
  expireAfterDays,
  expireWarnDays = 0
) {
  const url = `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/notification`;
  const response = await loggedFetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      // Must be false so the per-envelope expiration below is honored.
      useAccountDefaults: 'false',
      expirations: {
        expireEnabled: 'true',
        expireAfter: String(expireAfterDays),
        expireWarn: String(expireWarnDays)
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to update envelope notification: ${response.statusText} (${response.status}) - ${text}`);
  }

  return await safeJson(response, "DocuSign API Error");
}

/**
 * Fetches docGenFormFields metadata
 */
async function getDocGenFormFields(baseUri, accountId, accessToken, envelopeId) {
  const url = `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/docGenFormFields`;
  const response = await loggedFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    return null; // Some envelopes might not have docGen, safe to ignore
  }

  return await safeJson(response, "DocuSign API Error");
}

/**
 * Lists all available templates in the DocuSign account
 */
async function listTemplates(baseUri, accountId, accessToken) {
  const url = `${baseUri}/restapi/v2.1/accounts/${accountId}/templates`;
  const response = await loggedFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to list templates: ${response.statusText} (${response.status})`);
  }

  const data = await safeJson(response, "DocuSign API Error");
  return data.envelopeTemplates || [];
}

module.exports = {
  getAccessToken,
  getAccountInfo,
  listEnvelopes,
  listTemplates,
  getEnvelopeRecipientsWithTabs,
  getEnvelopeDocuments,
  getDocGenFormFields,
  getEnvelopeNotification,
  updateEnvelopeNotification,
  voidEnvelope
};
