## Permagit CLI

### Requirements

- Node.js 18+ (recommended 20+)
- Git installed
- A browser wallet (e.g., Phantom)

### Commands

#### Login

```
permagit login
```

Opens a browser to connect your wallet and sign the static message “Permagit Repo Encryption v1”. The signature is used to derive the AES key for private repositories. The CLI exits immediately after success.

#### Push

```
permagit push
```

Flow:

1. Auto-commit uncommitted changes.
2. Create a `git bundle --all` of the repo.
3. Open a browser UI for wallet connect → (optional) encrypt → fund → upload.
4. On success, the CLI prints a concise summary (Repo/Branch/Visibility/Bundle size/TxID/Gateway) and exits immediately.

Private repos are encrypted in the browser using AES‑256‑GCM with a key derived from your login signature.

#### Repo registration (payments + multisig)

```
permagit repo register --payment <txSig> [--signers pk1,pk2,...] [--threshold N]
```

- Verifies the SPL token transfer (`/payments/verify`) and registers repo metadata with the backend.
- Use `--signers` to enable multisig approvals (owner is auto-added if missing).
- Stores the assigned `repoId` inside `.permagit.json` for later OTP/multisig operations.

#### Irys: status and funding

```
permagit irys --status
permagit irys --fund 0.1
```

- `--status`: Shows your Irys balance (atomic). It uses the same uploader node/endpoint shapes the Fund UI does (e.g. uploader.irys.xyz).
- `--fund <amount>`: Opens the browser Fund UI to pre-fund your Irys balance. Shows before/after balances and exits immediately.

Standalone fund:

```
permagit fund --amount 0.1
```

#### Logs

```
permagit logs
permagit logs --limit 50
permagit logs --repo my-repo
permagit logs --owner <PUBLIC_KEY>
```

Lists recent push logs stored by the backend in descending order.

#### Clone

```
permagit clone [txId] [targetDir]
permagit clone <txId> my-repo --encrypted
permagit clone --otp <otp-token> --encrypted
```

Downloads a bundle from Irys Gateway and restores it to a Git repo. If `--encrypted` is set, the CLI decrypts using your stored login signature (layout auto-detection supported). When you pass `--otp <token>`, the CLI redeems the OTP, pulls the shared decrypt key from the backend, and skips the manual txId argument.

#### OTP sharing

```
permagit otp request --payment <txSig> --bundle <txId>
permagit otp redeem --otp <token>
```

- `otp request` consumes a paid tx (purpose `otp_share`) and creates a one-time password + decrypt key tied to a bundle.
- `otp redeem` is primarily for verification/debugging; `permagit clone --otp` redeems automatically.

#### Multisig approvals

```
permagit approve --tx <pushTxId> [--repo my-repo] [--owner ownerPubkey]
```

Opens a lightweight wallet UI that signs the message `Permagit Push Approval:<txId>` via Phantom and submits it to `/multisig/approve`. Threshold status can be checked with `GET /multisig/status/:repoId/:txId` or directly via backend logs.

#### Private mode

Enable private mode at the repo level (example approach):

```
# write .permagit.json with { "private": true }
permagit private on
```

When private is true, Push UI encrypts the bundle with AES‑256‑GCM before upload.

### How it works

1. `permagit login`: save wallet public key and signature (for encryption key derivation).
2. `permagit push`: browser UI uploads the bundle via Irys Web SDK; RPC requests are proxied through your backend.
3. On success, the CLI logs the event to the backend and exits immediately.

### Troubleshooting

- Balance shows 0 in `irys --status`:
  - Run `permagit fund` once so the CLI learns the active uploader node URL from the UI. Status then queries that same node and endpoint shapes.
- Browser build errors about `Buffer` or `require`:
  - The CLI bundles the UI with browser polyfills. Rebuild (`npm run build`) and try again.

### Security

- The private key never leaves the wallet. The CLI stores only the public key and detached signature.
- All Solana RPC calls go through the backend you control.
