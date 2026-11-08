const docusign = require('./services/docusignService');

async function test() {
  const envId = 'e52a2bbb-8aea-8abb-81c3-192f4d83070b';
  console.log('Querying DocGenFormFields for Envelope:', envId);
  
  const accessToken = await docusign.getAccessToken();
  const account = await docusign.getAccountInfo(accessToken);
  
  const dgResp = await fetch(`${account.baseUrl}/accounts/${account.accountId}/envelopes/${envId}/docGenFormFields`, { 
    headers: { Authorization: `Bearer ${accessToken}` } 
  });
  
  if (!dgResp.ok) {
    console.log('DocuSign API Error:', dgResp.status, dgResp.statusText);
    const errText = await dgResp.text();
    console.log('Error Details:', errText);
  } else {
    const dgData = await dgResp.json();
    console.log(JSON.stringify(dgData, null, 2));
  }
}
test().catch(console.error);
