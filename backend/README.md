## Permagit Backend

### Overview

The backend now handles more than log storage:

- Proxies Solana JSON-RPC so the client never exposes a paid RPC URL.
- Tracks repo metadata, token payments, OTP shares, and multisig approvals in Postgres.
- Issues OTP tokens for private bundle sharing and coordinates multisig approvals.
- Still **never** holds user wallet secrets or private repo contents (only metadata + encryption keys explicitly shared for OTP flows).

### Tech Stack

- Node.js + TypeScript + Express
- Postgres (managed via `DATABASE_URL`)

### Environment (.env)

Create `backend/.env` (Railway-compatible):

```
# Server port (default: 4000)
PORT=4000

# Database
DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DB

# Solana RPC (paid RPC strongly recommended)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Token payment settings (used by /payments/verify)
PAYMENT_TOKEN_MINT=<SPL_TOKEN_MINT_ADDRESS>
PAYMENT_DESTINATION=<OUR_RECEIVING_WALLET>
PAYMENT_TOKEN_DECIMALS=6
PAYMENT_MIN_TOKENS=10   # minimum token amount (converted to USD off-chain)
```

Optional:

- `IRYS_FUND_ADDRESS` – bundler deposit address for CLI funding flows.
- `POSTGRES_URL` – alternate env name if Railway exposes it.

### Install & Run

```
cd backend
npm install

# Dev mode
npm run dev

# Or build + run
npm run build
npm start
```

### API Endpoints

- `POST /solana/rpc`
  - Transparent JSON-RPC proxy to `SOLANA_RPC_URL`.
  - Request body is forwarded as-is.
- `POST /solana/send-tx`
  - Broadcasts a signed transaction.
  - Body: `{ "txB64": string }` → Response: `{ "signature": string }`
- `GET /solana/recent-blockhash`
  - Convenience endpoint to fetch the latest blockhash.
- `POST /push-log`
  - Persist push logs to Postgres (and trigger multisig tracking when enabled).
  - Body: `{ repo, branch, txId, encrypted, owner }`.
- `GET /logs?owner=<pubkey>&repo=<name>`
  - Returns recent push logs in descending order.
- `GET /latest?owner=<pubkey>&repo=<name>`
  - Returns a single latest record matching filters.
- `GET /irys-fund-address`
  - Returns `IRYS_FUND_ADDRESS` from `.env` (optional).
- `POST /payments/verify`
  - Verifies an SPL token transfer (used for repo registration + OTP credits).
  - Body: `{ txSig, payer, purpose, repoName }`.
- `POST /repos`
  - Registers a repo (private + multisig metadata) after payment.
  - Body: `{ name, owner, isPrivate, signers, threshold, paymentTxSig }`.
- `GET /repos/:id` / `GET /repos?owner=&name=`
  - Fetch registered repo metadata.
- `POST /otp/request`
  - Issues an OTP for sharing a private bundle. Requires a fresh payment (`purpose=otp_share`).
  - Body: `{ repoId|owner+name, bundleTx, paymentTxSig, decryptKey? }`.
- `POST /otp/redeem`
  - Redeems an OTP, returning `{ bundleTx, decryptKey }` once.
- `POST /multisig/approve`
  - Stores a wallet-signed approval for a pending push (`signatureB64` of message `Permagit Push Approval:<txId>`).
- `GET /multisig/status/:repoId/:txId`
  - Returns approval counts + signer list for a pending push.

### Data

The schema is created automatically on boot (tables: `payments`, `repos`, `pushes`, `otp_tokens`, `multisig_pushes`, `multisig_signatures`).

### Operations & Security Notes

- Use a reliable paid Solana RPC provider for `SOLANA_RPC_URL`.
- If you expose this server publicly, consider adding authentication, CORS restrictions, and rate limiting.
- OTP decrypt keys are stored plaintext per spec—lock down Postgres with TLS + strict access.
- The backend never needs end-user wallet private keys; approvals are signature-only.
