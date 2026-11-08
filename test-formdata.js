const docusign = require('./services/docusignService');

async function test() {
  const envId = 'e52a2bbb-8aea-8abb-81c3-192f4d83070b';
  console.log('Querying Form Data for Envelope:', envId);
  
  const accessToken = await docusign.getAccessToken();
  const account = await docusign.getAccountInfo(accessToken);
  
  const fdResp = await fetch(`${account.baseUrl}/accounts/${account.accountId}/envelopes/${envId}/form_data`, { 
    headers: { Authorization: `Bearer ${accessToken}` } 
  });
  
  if (!fdResp.ok) {
    console.log('Error:', fdResp.status, await fdResp.text());
  } else {
    const fdData = await fdResp.json();
    console.log(JSON.stringify(fdData, null, 2));
  }
}
test().catch(console.error);
