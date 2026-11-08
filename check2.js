const xrpl = require('xrpl');
const w = require('./wallets.json');
(async () => {
  const c = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
  await c.connect();
  console.log('wallets.json keys:', Object.keys(w));
  console.log('issuer in wallets.json:', w.issuer && w.issuer.address);
  const r = await c.request({ command: 'account_lines', account: w.treasury.address });
  console.log('treasury lines:', r.result.lines);
  await c.disconnect();
})();
