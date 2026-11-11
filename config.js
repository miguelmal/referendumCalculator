require('dotenv').config();

module.exports = {
  docusign: {
    integrationKey: process.env.DOCUSIGN_INTEGRATION_KEY,
    secretKey: process.env.DOCUSIGN_SECRET_KEY,
    userId: process.env.DOCUSIGN_USER_ID,
    // Prefer inline PEM (containers / hosted platforms / secrets managers); fall back to file path for local dev
    privateKey: process.env.DOCUSIGN_RSA_PRIVATE_KEY || null,
    privateKeyPath: process.env.DOCUSIGN_RSA_PRIVATE_KEY_PATH || 'dev.pem',
    authServer: process.env.DOCUSIGN_AUTH_SERVER || 'account-d.docusign.com',
    accountId: process.env.DOCUSIGN_ACCOUNT_ID,
  },
  auth: {
    // Portal-only SSO. Enable DocuSign OAuth SSO by default when DOCUSIGN_SECRET_KEY is configured (unless SSO_ENABLED=false)
    ssoEnabled:
      process.env.SSO_ENABLED !== undefined
        ? process.env.SSO_ENABLED === 'true'
        : Boolean(process.env.DOCUSIGN_INTEGRATION_KEY && process.env.DOCUSIGN_SECRET_KEY),
    // Required when SSO is enabled; falls back to the OAuth client secret (never a hardcoded value).
    sessionSecret: process.env.SESSION_SECRET || process.env.DOCUSIGN_SECRET_KEY || null,
    redirectUri: process.env.SSO_REDIRECT_URI || null,
  },
};
