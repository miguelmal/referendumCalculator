const docusign = require('./services/docusignService');
const config = require('./config');

async function test() {
  const accessToken = await docusign.getAccessToken();
  const account = await docusign.getAccountInfo(accessToken);
  const baseUrl = account.baseUrl;
  const accountId = account.accountId;
  
  const url = new URL(`${baseUrl}/accounts/${accountId}/envelopes`);
  url.searchParams.append('from_date', config.fromDate);
  url.searchParams.append('status', 'sent');
  
  const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await resp.json();
  
  for (const env of data.envelopes || []) {
    console.log('Testing Sent Envelope ID:', env.envelopeId, 'Subject:', env.emailSubject);
    const dgResp = await fetch(`${baseUrl}/accounts/${accountId}/envelopes/${env.envelopeId}/docGenFormFields`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const dgData = await dgResp.json();
    console.log(JSON.stringify(dgData, null, 2));
  }
}
test().catch(console.error);
