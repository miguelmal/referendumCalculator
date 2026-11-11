/**
 * docusignService.js
 * DocuSign eSignature REST API client.
 *
 * All API calls authenticate server-to-server with the OAuth JWT grant, signed
 * with the integration's RSA private key (certificate). Portal SSO is separate
 * (routes/auth.js) and never used to call the DocuSign API.
 */
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

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
      throw new Error(`Failed to read RSA private key file: ${err.message}`);
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
  const response = await fetch(`https://${authHost}/oauth/token`, {
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
        `\n⚠️ User Consent Required!\n\nPlease open the link below in your web browser to grant consent, and then run this program again:\n\n${consentUrl}\n`
      );
    }
    throw new Error(`DocuSign JWT token assertion failed: ${data.error_description || data.error || response.statusText}`);
  }

  return data.access_token;
}

/**
 * Gets the account Base URI
 */
async function getAccountInfo(accessToken, envConfig) {
  const authHost = envConfig.authServer.replace(/^https?:\/\//i, '');
  const response = await fetch(`https://${authHost}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to get user info: ${response.statusText}`);
  }

  const data = await safeJson(response, "DocuSign API Error");
  const account = data.accounts.find(a => a.account_id === envConfig.accountId) || data.accounts[0];

  return {
    accountId: account.account_id,
    baseUri: account.base_uri
  };
}

/**
 * Fetches metadata for a single envelope by ID
 */
async function getEnvelope(baseUri, accountId, accessToken, envelopeId) {
  const url = `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch envelope ${envelopeId}: ${response.statusText}`);
  }

  return await safeJson(response, "DocuSign API Error");
}

/**
 * Fetches routing/recipient details (with tabs) for an envelope
 */
async function getEnvelopeRecipientsWithTabs(baseUri, accountId, accessToken, envelopeId) {
  const url = `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/recipients?include_tabs=true`;
  const response = await fetch(url, {
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
  const response = await fetch(url, {
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
  const response = await fetch(url, {
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
 * Fetches docGenFormFields metadata
 */
async function getDocGenFormFields(baseUri, accountId, accessToken, envelopeId) {
  const url = `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/docGenFormFields`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    return null; // Some envelopes might not have docGen, safe to ignore
  }

  return await safeJson(response, "DocuSign API Error");
}

/**
 * Lists available templates in the DocuSign account, optionally filtered since fromDate.
 * @param {string} baseUri
 * @param {string} accountId
 * @param {string} accessToken
 * @param {string|null} [fromDate=null] - ISO timestamp for incremental sync
 * @param {'created'|'modified'} [dateFilterType='created']
 */
async function listTemplates(baseUri, accountId, accessToken, fromDate = null, dateFilterType = 'created') {
  const url = new URL(`${baseUri}/restapi/v2.1/accounts/${accountId}/templates`);
  if (fromDate) {
    url.searchParams.append('from_date', fromDate);
    url.searchParams.append('from_to_status', dateFilterType);
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to list templates: ${response.statusText} (${response.status})`);
  }

  const data = await safeJson(response, "DocuSign API Error");
  return data.envelopeTemplates || [];
}

/**
 * Fetches metadata for a single template
 */
async function getTemplateDetails(baseUri, accountId, accessToken, templateId) {
  const url = `${baseUri}/restapi/v2.1/accounts/${accountId}/templates/${templateId}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch template ${templateId}: ${response.statusText} (${response.status})`);
  }

  return await safeJson(response, "DocuSign API Error");
}

/**
 * Fetches recipients + tabs (radioGroupTabs, checkboxTabs, textTabs) for a single template
 */
async function getTemplateRecipientsWithTabs(baseUri, accountId, accessToken, templateId) {
  const url = `${baseUri}/restapi/v2.1/accounts/${accountId}/templates/${templateId}/recipients?include_tabs=true`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch template recipients for ${templateId}: ${response.statusText} (${response.status})`);
  }

  return await safeJson(response, "DocuSign API Error");
}

module.exports = {
  getAccessToken,
  getAccountInfo,
  getEnvelope,
  listTemplates,
  getTemplateDetails,
  getTemplateRecipientsWithTabs,
  getEnvelopeRecipientsWithTabs,
  getEnvelopeDocuments,
  getDocGenFormFields,
  voidEnvelope
};
