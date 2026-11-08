// fund-rlusd.js
// Uses the Treasury's existing 100 XRP on XRPL Testnet to acquire RLUSD from the
// XRPL Testnet DEX (issuer rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV) using a multisigned OfferCreate,
// or checks if an RLUSD trustline balance is already present.

const xrpl = require('xrpl');
const fs = require('fs');
const path = require('path');

const TESTNET = 'wss://s.altnet.rippletest.net:51233';
const RLUSD_HEX = '524C555344000000000000000000000000000000';
const RLUSD_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';

async function main() {
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, 'wallets.json'), 'utf8'));
  const treasuryAddress = wallets.treasury.address;
  const ownerWallet = xrpl.Wallet.fromSeed(wallets.owner.seed);

  const client = new xrpl.Client(TESTNET);
  await client.connect();

  try {
    console.log('Checking RLUSD trustline balance for Treasury:', treasuryAddress);
    const lines = await client.request({
      command: 'account_lines',
      account: treasuryAddress,
    });
    console.log('Current trustlines:', lines.result.lines);

    // Check orderbook for RLUSD/XRP on Testnet
    const book = await client.request({
      command: 'book_offers',
      taker: treasuryAddress,
      taker_gets: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER },
      taker_pays: { currency: 'XRP' },
      limit: 5,
    });
    console.log('RLUSD DEX Offers available:', book.result.offers?.length || 0);

    if (book.result.offers && book.result.offers.length > 0) {
      console.log('Buying 50 RLUSD on XRPL Testnet DEX using 50 XRP (signed with Owner key weight 2)...');
      const offerTx = {
        TransactionType: 'OfferCreate',
        Account: treasuryAddress,
        TakerGets: xrpl.xrpToDrops('50'), // Pay up to 50 XRP
        TakerPays: {
          currency: RLUSD_HEX,
          issuer: RLUSD_ISSUER,
          value: '50',
        },
        Flags: xrpl.OfferCreateFlags.tfImmediateOrCancel,
      };

      const prepared = await client.autofill(offerTx, 1);
      const signed = ownerWallet.sign(prepared, true).tx_blob;
      const multi = xrpl.multisign([signed]);
      const res = await client.submitAndWait(multi);
      console.log('DEX OfferCreate result:', res.result.meta.TransactionResult);
    }

    const afterLines = await client.request({
      command: 'account_lines',
      account: treasuryAddress,
    });
    console.log('Updated trustlines:', afterLines.result.lines);
  } finally {
    await client.disconnect();
  }
}

main().catch(console.error);
