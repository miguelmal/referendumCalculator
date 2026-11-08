require('dotenv').config();

module.exports = {
  docusign: {
    integrationKey: process.env.DOCUSIGN_INTEGRATION_KEY,
    userId: process.env.DOCUSIGN_USER_ID,
    // Prefer inline PEM (containers / Secrets Manager); fall back to file path for local dev
    privateKey: process.env.DOCUSIGN_RSA_PRIVATE_KEY || null,
    privateKeyPath: process.env.DOCUSIGN_RSA_PRIVATE_KEY_PATH || 'dev.pem',
    authServer: process.env.DOCUSIGN_AUTH_SERVER || 'account-d.docusign.com',
    accountId: process.env.DOCUSIGN_ACCOUNT_ID,
  }
};
