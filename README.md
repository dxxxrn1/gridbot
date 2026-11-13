# GridBot — Autonomous Prepaid-Resource AI CFO

GridBot is an autonomous treasury and utility-purchasing agent built for South African small businesses (e.g., internet cafes) using **RLUSD on XRPL Testnet**. It monitors prepaid utility balances (electricity and LTE backup data), enforces off-chain spending caps through an isolated Policy Service, settles approved payments via **XRPL 2-of-2 Multi-Sign**, and provides both a responsive Vision UI web dashboard and Telegram Owner Controls.

---

## Architecture

- **Main App (`server.js`, port `3000`)**:
  - Serves the web dashboard ([public/index.html](public/index.html)) and WebSocket live updates.
  - Runs the utility meter monitor ([monitor.js](monitor.js)) and AI decision / SKU-matching agent ([agent.js](agent.js)).
  - Holds **only** the `agent` signing key (`wallets.agent.json`, signer weight `1` of quorum `2`) — it cannot move treasury funds alone.
  - Proxies owner actions by forwarding the browser's `x-owner-passcode` header per request without storing it server-side.
- **Isolated Policy Service (`policy-service/server.js`, port `4000`)**:
  - Holds the `policy` co-signing key (weight `1`) and `owner` override key (weight `2`).
  - Enforces `per_tx_cap`, `daily_cap`, `allowed_payees`, and duplicate/velocity guards before co-signing.
  - Persists policy config, transactions, and staff accounts in **Supabase** (with an automatic local fallback indicator if Supabase is unreachable).
- **Telegram Bot (`telegram.js`)**:
  - Sends 25% low-balance warnings, auto-approved receipts, and pending-owner approval alerts.
  - Supports interactive Owner Control Menu (`/start`, `/menu`, `/status`, `/pending`, `/topup_elec`, `/topup_data`) and PIN-protected approvals (`/approve <id> <PIN>`, `/reject <id> <PIN>`).

---

## Prerequisites

- **Node.js** 18+ (for native `fetch`)
- **Supabase** project (for `policy`, `transactions`, and `staff_users` tables)
- **XRPL Testnet** wallets configured in `wallets.public.json`, `wallets.agent.json`, and `policy-service/wallets.keys.json`
- *(Optional)* **Telegram Bot Token** & Chat ID for mobile owner alerts/approvals
- *(Optional)* **Groq API Key** for AI SKU matching in [agent.js](agent.js)

---

## Setup

### 1. Install Dependencies

```bash
npm install
cd policy-service && npm install && cd ..
```

### 2. Configure Supabase Schema

Run [policy-service/schema.sql](policy-service/schema.sql) in your Supabase SQL Editor. It creates:
- `public.policy`
- `public.transactions`
- `public.staff_users`

For an existing database, also run [policy-service/migrations/002_demo_day_reset.sql](policy-service/migrations/002_demo_day_reset.sql). The owner-only “Start new demo day” control requires this column; it moves the spend-counting window without deleting transaction history.

### 3. Configure Environment Variables

#### Root `.env`
```env
PORT=3000
POLICY_SERVICE_URL=http://127.0.0.1:4000
AGENT_API_TOKEN=your-shared-agent-token
DEMO_MODE=false

# Required (minimum 6 characters each; service refuses to start if missing/shorter)
OWNER_PASSCODE=your-owner-passcode
STAFF_PASSCODE=your-staff-passcode

# Optional: Telegram Owner Bot
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
TELEGRAM_ALLOWED_CHAT_IDS=your-chat-id
TELEGRAM_APPROVE_PIN=your-telegram-pin

# Optional: AI decisioning & XRPL explorer
GROQ_API_KEY=your-groq-key
XRPL_EXPLORER_BASE=https://testnet.xrpl.org/transactions
```

Set `DEMO_MODE=true` in the root `.env` only when you want to expose the owner-only Red Team prompt-injection drill. The drill sends a deliberately invalid proposal to the Policy Service; it should be blocked and logged, and must never submit a payment.

#### `policy-service/.env`
```env
PORT=4000
AGENT_API_TOKEN=your-shared-agent-token

# Required (minimum 6 characters each; service refuses to start if missing/shorter)
OWNER_PASSCODE=your-owner-passcode
STAFF_PASSCODE=your-staff-passcode

# Telegram approval PIN (must match root .env if using Telegram approvals)
TELEGRAM_APPROVE_PIN=your-telegram-pin
TELEGRAM_ALLOWED_CHAT_IDS=your-chat-id

# Supabase credentials
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-supabase-service-role-key
```

---

## Running the App

Start the Policy Service and Main App (note: `npm start` also auto-spawns `policy-service/server.js` if port `4000` is not already listening):

```bash
# Terminal 1 (optional, or let server.js start it)
npm run policy

# Terminal 2
npm start
```

Open **http://localhost:3000** in your browser.

---

## Scripts

- `npm start` — Starts the GridBot main server (`server.js`) on port `3000`.
- `npm run policy` — Starts the isolated Policy Service (`policy-service/server.js`) on port `4000`.
- `npm test` — Runs `test-policy-service.js`.

---

## Project Structure

```text
.
├── server.js                 # Main Express + WebSocket server
├── agent.js                  # Autonomous decision & plain-language SKU matcher
├── auth.js                   # Role-based session auth (Owner & Staff)
├── monitor.js                # Live prepaid meter monitor & 25% warning triggers
├── policy-client.js          # HTTP client to Policy Service + read-only XRPL proof
├── resources.js              # Utility meter plugins (electricity, LTE data) & vending
├── telegram.js               # Telegram bot alerts, control menu, and PIN approvals
├── public/
│   └── index.html            # Responsive Vision UI dashboard & mobile bottom-tab nav
└── policy-service/
    ├── server.js             # Isolated Policy Service API (port 4000)
    ├── signer.js             # XRPL 2-of-2 & owner-override multi-sign submitter
    ├── db.js                 # Supabase persistence (+ storage mode reporting)
    └── schema.sql            # Supabase SQL schema (policy, transactions, staff_users)
```
