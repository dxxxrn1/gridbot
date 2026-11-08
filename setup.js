// setup.js - run ONCE. Creates a testnet RLUSD stand-in issuer, mints 1,000 into the
// treasury, then locks the treasury behind the multi-sign rules.
// npm i xrpl   |   node setup.js
const xrpl = require("xrpl");
const fs = require("fs");

const TESTNET = "wss://s.altnet.rippletest.net:51233";
const RLUSD_HEX = "524C555344000000000000000000000000000000";

async function submit(client, wallet, tx) {
  const res = await client.submitAndWait(tx, { wallet });
  const code = res.result.meta.TransactionResult;
  if (code !== "tesSUCCESS") throw new Error(`${tx.TransactionType} failed: ${code}`);
  console.log(`  ok ${tx.TransactionType} -> https://testnet.xrpl.org/transactions/${res.result.hash}`);
}

async function main() {
  const client = new xrpl.Client(TESTNET);
  await client.connect();
  try {
    console.log("1. Funding issuer, treasury, utility from faucet...");
    const { wallet: issuer } = await client.fundWallet();
    const { wallet: treasury } = await client.fundWallet();
    const { wallet: utility } = await client.fundWallet();

    // Signers only need keypairs, not funded accounts
    const owner = xrpl.Wallet.generate();
    const agent = xrpl.Wallet.generate();
    const policy = xrpl.Wallet.generate();

    console.log("2. Issuer: enable DefaultRipple (before any trustlines exist)...");
    await submit(client, issuer, {
      TransactionType: "AccountSet",
      Account: issuer.address,
      SetFlag: xrpl.AccountSetAsfFlags.asfDefaultRipple,
    });

    console.log("3. RLUSD trustlines (treasury + utility -> our issuer)...");
    for (const w of [treasury, utility]) {
      await submit(client, w, {
        TransactionType: "TrustSet",
        Account: w.address,
        LimitAmount: { currency: RLUSD_HEX, issuer: issuer.address, value: "1000000" },
        Flags: 131072, // tfSetNoRipple
      });
    }

    console.log("4. Minting 1,000 testnet RLUSD into treasury...");
    await submit(client, issuer, {
      TransactionType: "Payment",
      Account: issuer.address,
      Destination: treasury.address,
      Amount: { currency: RLUSD_HEX, issuer: issuer.address, value: "1000" },
    });

    console.log("5. Signer list on treasury: agent(1) + policy(1) + owner(2), quorum 2...");
    await submit(client, treasury, {
      TransactionType: "SignerListSet",
      Account: treasury.address,
      SignerQuorum: 2,
      SignerEntries: [
        { SignerEntry: { Account: agent.address, SignerWeight: 1 } },
        { SignerEntry: { Account: policy.address, SignerWeight: 1 } },
        { SignerEntry: { Account: owner.address, SignerWeight: 2 } },
      ],
    });

    console.log("6. Disabling treasury master key...");
    await submit(client, treasury, {
      TransactionType: "AccountSet",
      Account: treasury.address,
      SetFlag: xrpl.AccountSetAsfFlags.asfDisableMaster,
    });

    fs.writeFileSync(
      "wallets.json",
      JSON.stringify(
        {
          issuer: { address: issuer.address, seed: issuer.seed },
          treasury: { address: treasury.address },
          utility: { address: utility.address },
          owner: { address: owner.address, seed: owner.seed },
          agent: { address: agent.address, seed: agent.seed },
          policy: { address: policy.address, seed: policy.seed },
        },
        null,
        2
      )
    );

    console.log("\nDone. wallets.json saved (TESTNET ONLY - keep it in .gitignore).");
    console.log("Treasury:", treasury.address);
    console.log("Utility (new allowlist payee):", utility.address);
    console.log("Issuer:", issuer.address);
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});