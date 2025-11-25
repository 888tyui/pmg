import express from "express";
import cors from "cors";
import { getPool, initSchema } from "./db.js";
import dotenv from "dotenv";
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { randomUUID, randomBytes } from "crypto";
import nacl from "tweetnacl";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from "@solana/spl-token";

dotenv.config();

function getSolanaConnection() {
  const url =
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  return new Connection(url, "confirmed");
}

const textEncoder = new TextEncoder();

const PAYMENT_DESTINATION = process.env.PAYMENT_DESTINATION || "";
const PAYMENT_TOKEN_MINT = process.env.PAYMENT_TOKEN_MINT || "";
const PAYMENT_TOKEN_DECIMALS = parseInt(
  process.env.PAYMENT_TOKEN_DECIMALS || "9",
  10
);
const PAYMENT_MIN_TOKENS = process.env.PAYMENT_MIN_TOKENS || "10";
const MIN_PAYMENT_ATOMIC =
  PAYMENT_MIN_TOKENS && !Number.isNaN(PAYMENT_TOKEN_DECIMALS)
    ? decimalToAtomic(PAYMENT_MIN_TOKENS, PAYMENT_TOKEN_DECIMALS)
    : 0n;
const PAYMENT_TOKEN_MINT_PK = process.env.PAYMENT_TOKEN_MINT
  ? new PublicKey(process.env.PAYMENT_TOKEN_MINT)
  : null;
const PAYMENT_DESTINATION_PK = process.env.PAYMENT_DESTINATION
  ? new PublicKey(process.env.PAYMENT_DESTINATION)
  : null;

function decimalToAtomic(value: string, decimals: number): bigint {
  if (typeof value !== "string") {
    throw new Error("invalid_decimal");
  }
  const normalized = value.trim();
  if (!/^(\d+)(\.\d+)?$/.test(normalized)) {
    throw new Error("invalid_decimal");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const fracPadded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${fracPadded}`.replace(/^0+/, "");
  return BigInt(combined || "0");
}

function atomicToDecimal(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const raw = abs.toString().padStart(decimals + 1, "0");
  const intPart =
    decimals === 0 ? raw : raw.slice(0, raw.length - decimals) || "0";
  const fracPart = decimals === 0 ? "" : raw.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${intPart}${fracPart ? `.${fracPart}` : ""}`;
}

function parseSigners(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter((v) => v.length > 0);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}

function calcThreshold(signers: string[], maybeThreshold?: number | null) {
  if (!signers.length) return null;
  if (maybeThreshold && maybeThreshold > 0 && maybeThreshold <= signers.length) {
    return maybeThreshold;
  }
  return Math.ceil(signers.length / 2);
}

async function getRepoByOwnerAndName(owner?: string | null, name?: string | null) {
  if (!owner || !name) return null;
  const pool = getPool();
  const result = await pool.query(
    "SELECT * FROM repos WHERE owner = $1 AND name = $2 LIMIT 1",
    [owner, name]
  );
  return result.rows[0] || null;
}

function verifyApprovalSignature(txId: string, signer: string, signatureB64: string) {
  if (!txId || !signer || !signatureB64) {
    throw new Error("missing_signature_fields");
  }
  const message = `Permagit Push Approval:${txId}`;
  const messageBytes = textEncoder.encode(message);
  let signature: Uint8Array;
  let pubkey: Uint8Array;
  try {
    signature = new Uint8Array(Buffer.from(signatureB64, "base64"));
  } catch {
    throw new Error("invalid_signature_encoding");
  }
  try {
    pubkey = new PublicKey(signer).toBytes();
  } catch {
    throw new Error("invalid_signer");
  }
  const ok = nacl.sign.detached.verify(messageBytes, signature, pubkey);
  if (!ok) {
    throw new Error("signature_verification_failed");
  }
}

async function ensureMultisigEntry(
  repo: any,
  pushTx: string,
  branch?: string | null
) {
  if (!repo || !repo.is_multisig) return null;
  const pool = getPool();
  const signers: string[] = Array.isArray(repo.signers) ? repo.signers : [];
  const threshold = calcThreshold(signers, repo.threshold);
  if (!threshold) return null;
  const id = randomUUID();
  await pool.query(
    `
    INSERT INTO multisig_pushes (id, repo_id, push_tx, branch, approvals_required)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (repo_id, push_tx) DO NOTHING
  `,
    [id, repo.id, pushTx, branch || null, threshold]
  );
  const { rows } = await pool.query(
    "SELECT * FROM multisig_pushes WHERE repo_id = $1 AND push_tx = $2",
    [repo.id, pushTx]
  );
  return rows[0] || null;
}

async function verifyTokenPayment(txSig: string) {
  if (!PAYMENT_DESTINATION || !PAYMENT_TOKEN_MINT) {
    throw new Error("payment_env_not_configured");
  }
  const conn = getSolanaConnection();
  const tx = await conn.getTransaction(txSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta) {
    throw new Error("transaction_not_found");
  }
  if (tx.meta.err) {
    throw new Error("transaction_failed");
  }
  const postBalances = tx.meta.postTokenBalances || [];
  const preBalances = tx.meta.preTokenBalances || [];
  const dest = postBalances.find(
    (entry) =>
      entry.owner === PAYMENT_DESTINATION && entry.mint === PAYMENT_TOKEN_MINT
  );
  if (!dest) {
    throw new Error("destination_not_involved");
  }
  const preMatch = preBalances.find(
    (entry) =>
      entry.mint === PAYMENT_TOKEN_MINT &&
      entry.owner === PAYMENT_DESTINATION &&
      entry.accountIndex === dest.accountIndex
  );
  const postAmount = BigInt(dest.uiTokenAmount?.amount || "0");
  const preAmount = BigInt(preMatch?.uiTokenAmount?.amount || "0");
  const delta = postAmount - preAmount;
  if (delta <= 0n) {
    throw new Error("no_deposit_detected");
  }
  const decimals =
    typeof dest.uiTokenAmount?.decimals === "number"
      ? dest.uiTokenAmount.decimals
      : PAYMENT_TOKEN_DECIMALS;
  return {
    amountAtomic: delta,
    decimals,
  };
}

function formatPaymentRow(row: any) {
  if (!row) return null;
  const tokenAmountAtomic = BigInt(row.token_amount_atomic || "0");
  return {
    id: row.id,
    txSig: row.tx_sig,
    payer: row.payer,
    purpose: row.purpose,
    tokenAmountAtomic: tokenAmountAtomic.toString(),
    tokenAmount: atomicToDecimal(tokenAmountAtomic, PAYMENT_TOKEN_DECIMALS),
    status: row.status,
    repoName: row.repo_name,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
    metadata: row.metadata || {},
  };
}

async function buildPaymentTransaction(payer: string) {
  if (!PAYMENT_DESTINATION_PK || !PAYMENT_TOKEN_MINT_PK) {
    throw new Error("payment_env_not_configured");
  }
  if (!MIN_PAYMENT_ATOMIC || MIN_PAYMENT_ATOMIC <= 0n) {
    throw new Error("payment_amount_not_set");
  }
  const payerPk = new PublicKey(payer);
  const connection = getSolanaConnection();
  const payerAta = getAssociatedTokenAddressSync(
    PAYMENT_TOKEN_MINT_PK,
    payerPk
  );
  const destAta = getAssociatedTokenAddressSync(
    PAYMENT_TOKEN_MINT_PK,
    PAYMENT_DESTINATION_PK
  );
  const instructions: any[] = [];
  const payerAtaInfo = await connection.getAccountInfo(payerAta);
  if (!payerAtaInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        payerPk,
        payerAta,
        payerPk,
        PAYMENT_TOKEN_MINT_PK,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  const destAtaInfo = await connection.getAccountInfo(destAta);
  if (!destAtaInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        payerPk,
        destAta,
        PAYMENT_DESTINATION_PK,
        PAYMENT_TOKEN_MINT_PK,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  instructions.push(
    createTransferInstruction(
      payerAta,
      destAta,
      payerPk,
      MIN_PAYMENT_ATOMIC,
      [],
      TOKEN_PROGRAM_ID
    )
  );
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  const message = new TransactionMessage({
    payerKey: payerPk,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const b64 = Buffer.from(tx.serialize()).toString("base64");
  return {
    txB64: b64,
    amountAtomic: MIN_PAYMENT_ATOMIC.toString(),
    destination: PAYMENT_DESTINATION_PK.toBase58(),
    mint: PAYMENT_TOKEN_MINT_PK.toBase58(),
  };
}

function formatRepoRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    isPrivate: row.is_private,
    isMultisig: row.is_multisig,
    threshold: row.threshold,
    signers: Array.isArray(row.signers) ? row.signers : row.signers ?? [],
    paymentTx: row.payment_tx,
    createdAt: row.created_at,
  };
}

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: "64mb" }));
// Simple request/response logging middleware
app.use((req, res, next) => {
  const startedAt = Date.now();
  let reqInfo: any = undefined;
  try {
    if (req.method === "GET") {
      reqInfo = { query: req.query };
    } else {
      const body = req.body;
      const size = body ? JSON.stringify(body).length : 0;
      reqInfo = {
        keys: body && typeof body === "object" ? Object.keys(body) : [],
        size,
      };
    }
  } catch {
    reqInfo = undefined;
  }
  // eslint-disable-next-line no-console
  console.log(`[REQ] ${req.method} ${req.originalUrl}`, reqInfo ?? "");
  res.on("finish", () => {
    const ms = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.log(
      `[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms}ms`
    );
  });
  next();
});

// Irys SDK is bundled client-side; no SDK assets served from backend.

initSchema().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to initialize database schema:", err);
  process.exit(1);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Provide recent blockhash via server-side RPC
app.get("/solana/recent-blockhash", async (_req, res) => {
  try {
    const conn = getSolanaConnection();
    const bh = await conn.getLatestBlockhash("finalized");
    res.json(bh);
  } catch (e: any) {
    res
      .status(500)
      .json({ error: "rpc_error", message: e?.message || String(e) });
  }
});

// Relay a signed tx to chain without exposing RPC
app.post("/solana/send-tx", async (req, res) => {
  try {
    const { txB64 } = req.body || {};
    if (!txB64) return res.status(400).json({ error: "txB64_required" });
    const raw = Buffer.from(String(txB64), "base64");
    const conn = getSolanaConnection();
    const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
    await conn.confirmTransaction(sig, "confirmed");
    res.json({ signature: sig });
  } catch (e: any) {
    res
      .status(500)
      .json({ error: "send_failed", message: e?.message || String(e) });
  }
});

// JSON-RPC proxy to hide paid RPC URL from client
app.post("/solana/rpc", async (req, res) => {
  try {
    const url =
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(text);
  } catch (e: any) {
    res
      .status(500)
      .json({ error: "rpc_proxy_failed", message: e?.message || String(e) });
  }
});

app.post("/payments/verify", async (req, res) => {
  try {
    const { txSig, payer, purpose = "repo_init", repoName } = req.body || {};
    if (!txSig || typeof txSig !== "string") {
      return res.status(400).json({ error: "txSig_required" });
    }
    if (!purpose || typeof purpose !== "string") {
      return res.status(400).json({ error: "purpose_required" });
    }
    if (!PAYMENT_DESTINATION || !PAYMENT_TOKEN_MINT) {
      return res.status(500).json({ error: "payment_env_not_configured" });
    }
    const pool = getPool();
    const existing = await pool.query(
      "SELECT * FROM payments WHERE tx_sig = $1 LIMIT 1",
      [txSig]
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.purpose !== purpose) {
        return res.status(400).json({ error: "purpose_mismatch" });
      }
      if (row.status !== "confirmed") {
        await pool.query("UPDATE payments SET status = 'confirmed' WHERE id = $1", [
          row.id,
        ]);
        row.status = "confirmed";
      }
      return res.json({ payment: formatPaymentRow(row), reused: true });
    }
    const chainInfo = await verifyTokenPayment(txSig);
    if (chainInfo.amountAtomic < MIN_PAYMENT_ATOMIC) {
      return res.status(400).json({ error: "insufficient_amount" });
    }
    const paymentId = randomUUID();
    const metadata = {
      decimals: chainInfo.decimals,
      minTokens: PAYMENT_MIN_TOKENS,
      destination: PAYMENT_DESTINATION,
      mint: PAYMENT_TOKEN_MINT,
    };
    const insert = await pool.query(
      `
      INSERT INTO payments (id, tx_sig, payer, purpose, token_amount_atomic, status, repo_name, metadata)
      VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, $7)
      RETURNING *
    `,
      [
        paymentId,
        txSig,
        payer || null,
        purpose,
        chainInfo.amountAtomic.toString(),
        repoName || null,
        metadata,
      ]
    );
    res.json({ payment: formatPaymentRow(insert.rows[0]) });
  } catch (err: any) {
    res
      .status(400)
      .json({ error: "payment_verification_failed", message: err?.message || String(err) });
  }
});

app.post("/payments/create", async (req, res) => {
  try {
    const { payer, purpose = "multisig_setup" } = req.body || {};
    if (!payer || typeof payer !== "string") {
      return res.status(400).json({ error: "payer_required" });
    }
    const tx = await buildPaymentTransaction(payer);
    res.json({
      txB64: tx.txB64,
      amountAtomic: tx.amountAtomic,
      destination: tx.destination,
      mint: tx.mint,
      purpose,
    });
  } catch (err: any) {
    res.status(400).json({
      error: "payment_create_failed",
      message: err?.message || String(err),
    });
  }
});

app.post("/repos", async (req, res) => {
  const { name, owner, isPrivate, signers, threshold, paymentTxSig } =
    req.body || {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name_required" });
  }
  if (!owner || typeof owner !== "string") {
    return res.status(400).json({ error: "owner_required" });
  }
  if (!paymentTxSig || typeof paymentTxSig !== "string") {
    return res.status(400).json({ error: "payment_required" });
  }
  const signerList = parseSigners(signers);
  const thresholdNumber =
    typeof threshold === "number" ? threshold : Number(threshold);
  const computedThreshold = calcThreshold(
    signerList,
    Number.isNaN(thresholdNumber) ? undefined : thresholdNumber
  );
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const paymentResult = await client.query(
      "SELECT * FROM payments WHERE tx_sig = $1 FOR UPDATE",
      [paymentTxSig]
    );
    if (!paymentResult.rows.length) {
      throw new Error("payment_not_found");
    }
    const payment = paymentResult.rows[0];
    if (payment.purpose !== "repo_init") {
      throw new Error("payment_wrong_purpose");
    }
    if (payment.status !== "confirmed") {
      throw new Error("payment_not_confirmed");
    }
    if (payment.consumed_at) {
      throw new Error("payment_already_consumed");
    }
    const repoId = randomUUID();
    const insert = await client.query(
      `
      INSERT INTO repos (id, name, owner, is_private, is_multisig, threshold, signers, payment_tx)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (owner, name) DO NOTHING
      RETURNING *
    `,
      [
        repoId,
        name.trim(),
        owner.trim(),
        Boolean(isPrivate),
        signerList.length > 0,
        computedThreshold,
        JSON.stringify(signerList),
        paymentTxSig,
      ]
    );
    if (!insert.rows.length) {
      throw new Error("repo_exists");
    }
    await client.query("UPDATE payments SET consumed_at = NOW() WHERE id = $1", [
      payment.id,
    ]);
    await client.query("COMMIT");
    res.json({ repo: formatRepoRow(insert.rows[0]) });
  } catch (err: any) {
    await client.query("ROLLBACK");
    res
      .status(400)
      .json({ error: "repo_create_failed", message: err?.message || String(err) });
  } finally {
    client.release();
  }
});

app.get("/repos/:id", async (req, res) => {
  try {
    const { rows } = await getPool().query("SELECT * FROM repos WHERE id = $1", [
      req.params.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ repo: formatRepoRow(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: "repo_lookup_failed" });
  }
});

app.get("/repos", async (req, res) => {
  const { owner, name } = req.query as { owner?: string; name?: string };
  if (!owner || !name) {
    return res.status(400).json({ error: "owner_and_name_required" });
  }
  try {
    const repo = await getRepoByOwnerAndName(owner, name);
    if (!repo) return res.status(404).json({ error: "not_found" });
    res.json({ repo: formatRepoRow(repo) });
  } catch (err) {
    res.status(500).json({ error: "repo_lookup_failed" });
  }
});

app.post("/otp/request", async (req, res) => {
  const {
    repoId,
    owner,
    name,
    bundleTx,
    paymentTxSig,
    decryptKey,
    expiresInMinutes,
  } = req.body || {};
  if (!bundleTx || typeof bundleTx !== "string") {
    return res.status(400).json({ error: "bundle_tx_required" });
  }
  if (!paymentTxSig || typeof paymentTxSig !== "string") {
    return res.status(400).json({ error: "payment_required" });
  }
  const repo =
    repoId && typeof repoId === "string"
      ? (
          await getPool().query("SELECT * FROM repos WHERE id = $1 LIMIT 1", [
            repoId,
          ])
        ).rows[0]
      : await getRepoByOwnerAndName(owner, name);
  if (!repo) {
    return res.status(404).json({ error: "repo_not_found" });
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const paymentResult = await client.query(
      "SELECT * FROM payments WHERE tx_sig = $1 FOR UPDATE",
      [paymentTxSig]
    );
    if (!paymentResult.rows.length) {
      throw new Error("payment_not_found");
    }
    const payment = paymentResult.rows[0];
    if (payment.purpose !== "otp_share") {
      throw new Error("payment_wrong_purpose");
    }
    if (payment.status !== "confirmed") {
      throw new Error("payment_not_confirmed");
    }
    if (payment.consumed_at) {
      throw new Error("payment_already_consumed");
    }
    const otp = randomBytes(16).toString("hex");
    const key =
      typeof decryptKey === "string" && decryptKey.length > 0
        ? decryptKey
        : randomBytes(32).toString("base64");
    const ttlMinutes =
      typeof expiresInMinutes === "number" && expiresInMinutes > 0
        ? expiresInMinutes
        : 60 * 24;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    const otpId = randomUUID();
    await client.query(
      `
      INSERT INTO otp_tokens (id, repo_id, payment_tx, otp_plain, decrypt_key, bundle_tx, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
      [otpId, repo.id, paymentTxSig, otp, key, bundleTx, expiresAt.toISOString()]
    );
    await client.query("UPDATE payments SET consumed_at = NOW() WHERE id = $1", [
      payment.id,
    ]);
    await client.query("COMMIT");
    res.json({
      otp,
      decryptKey: key,
      bundleTx,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err: any) {
    await client.query("ROLLBACK");
    res
      .status(400)
      .json({ error: "otp_create_failed", message: err?.message || String(err) });
  } finally {
    client.release();
  }
});

app.post("/otp/redeem", async (req, res) => {
  const { otp } = req.body || {};
  if (!otp || typeof otp !== "string") {
    return res.status(400).json({ error: "otp_required" });
  }
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT * FROM otp_tokens WHERE otp_plain = $1 LIMIT 1",
      [otp]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "otp_not_found" });
    }
    const row = rows[0];
    if (row.used_at) {
      return res.status(410).json({ error: "otp_already_used" });
    }
    const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ error: "otp_expired" });
    }
    const update = await pool.query(
      "UPDATE otp_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL",
      [row.id]
    );
    if (update.rowCount === 0) {
      return res.status(410).json({ error: "otp_already_used" });
    }
    res.json({
      repoId: row.repo_id,
      bundleTx: row.bundle_tx,
      decryptKey: row.decrypt_key,
    });
  } catch (err) {
    res.status(500).json({ error: "otp_redeem_failed" });
  }
});

app.post("/multisig/approve", async (req, res) => {
  const { repoId, owner, name, txId, signer, signatureB64 } = req.body || {};
  if (!txId || typeof txId !== "string") {
    return res.status(400).json({ error: "txId_required" });
  }
  if (!signer || typeof signer !== "string") {
    return res.status(400).json({ error: "signer_required" });
  }
  if (!signatureB64 || typeof signatureB64 !== "string") {
    return res.status(400).json({ error: "signature_required" });
  }
  const repo =
    repoId && typeof repoId === "string"
      ? (
          await getPool().query("SELECT * FROM repos WHERE id = $1 LIMIT 1", [
            repoId,
          ])
        ).rows[0]
      : await getRepoByOwnerAndName(owner, name);
  if (!repo || !repo.is_multisig) {
    return res.status(404).json({ error: "repo_not_multisig" });
  }
  const signers: string[] = Array.isArray(repo.signers) ? repo.signers : [];
  if (!signers.includes(signer)) {
    return res.status(403).json({ error: "signer_not_authorized" });
  }
  try {
    verifyApprovalSignature(txId, signer, signatureB64);
  } catch (err: any) {
    return res
      .status(400)
      .json({ error: "signature_invalid", message: err?.message || String(err) });
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const pushResult = await client.query(
      "SELECT * FROM multisig_pushes WHERE repo_id = $1 AND push_tx = $2 FOR UPDATE",
      [repo.id, txId]
    );
    if (!pushResult.rows.length) {
      throw new Error("push_not_tracked");
    }
    const push = pushResult.rows[0];
    try {
      await client.query(
        `
        INSERT INTO multisig_signatures (id, multisig_push_id, signer, signature_b64)
        VALUES ($1, $2, $3, $4)
      `,
        [randomUUID(), push.id, signer, signatureB64]
      );
    } catch (err: any) {
      if (err?.code === "23505") {
        throw new Error("signature_already_submitted");
      }
      throw err;
    }
    const countResult = await client.query(
      "SELECT COUNT(*)::int AS count FROM multisig_signatures WHERE multisig_push_id = $1",
      [push.id]
    );
    const approvalsCount = countResult.rows[0]?.count || 0;
    let status = push.status;
    if (
      approvalsCount >= push.approvals_required &&
      push.status !== "approved"
    ) {
      await client.query(
        "UPDATE multisig_pushes SET status = 'approved', approvals_count = $1, approved_at = NOW() WHERE id = $2",
        [approvalsCount, push.id]
      );
      status = "approved";
    } else {
      await client.query(
        "UPDATE multisig_pushes SET approvals_count = $1 WHERE id = $2",
        [approvalsCount, push.id]
      );
    }
    await client.query("COMMIT");
    res.json({
      status,
      approvalsCount,
      approvalsRequired: push.approvals_required,
    });
  } catch (err: any) {
    await client.query("ROLLBACK");
    res
      .status(400)
      .json({ error: "multisig_approval_failed", message: err?.message || String(err) });
  } finally {
    client.release();
  }
});

app.get("/multisig/status/:repoId/:txId", async (req, res) => {
  try {
    const pool = getPool();
    const pushResult = await pool.query(
      "SELECT * FROM multisig_pushes WHERE repo_id = $1 AND push_tx = $2",
      [req.params.repoId, req.params.txId]
    );
    if (!pushResult.rows.length) {
      return res.status(404).json({ error: "multisig_push_not_found" });
    }
    const push = pushResult.rows[0];
    const sigs = await pool.query(
      "SELECT signer, signature_b64, created_at FROM multisig_signatures WHERE multisig_push_id = $1 ORDER BY created_at ASC",
      [push.id]
    );
    res.json({
      status: push.status,
      approvalsCount: push.approvals_count,
      approvalsRequired: push.approvals_required,
      approvedAt: push.approved_at,
      signatures: sigs.rows,
    });
  } catch (err) {
    res.status(500).json({ error: "multisig_status_failed" });
  }
});

app.post("/multisig/setup", async (req, res) => {
  try {
    const {
      repoId,
      owner,
      name,
      pushTx,
      signers,
      threshold,
      paymentTxSig,
    } = req.body || {};
    if (!pushTx) {
      return res.status(400).json({ error: "push_tx_required" });
    }
    if (!paymentTxSig) {
      return res.status(400).json({ error: "payment_required" });
    }
    const signerList = parseSigners(signers);
    if (!signerList.length) {
      return res.status(400).json({ error: "signers_required" });
    }
    const thresholdNumber =
      typeof threshold === "number" ? threshold : Number(threshold);
    const computedThreshold = calcThreshold(
      signerList,
      Number.isNaN(thresholdNumber) ? undefined : thresholdNumber
    );
    if (!computedThreshold) {
      return res.status(400).json({ error: "invalid_threshold" });
    }
    const pool = getPool();
    const paymentResult = await pool.query(
      "SELECT * FROM payments WHERE tx_sig = $1",
      [paymentTxSig]
    );
    if (!paymentResult.rows.length) {
      return res.status(400).json({ error: "payment_not_found" });
    }
    const payment = paymentResult.rows[0];
    if (payment.purpose !== "multisig_setup") {
      return res.status(400).json({ error: "payment_wrong_purpose" });
    }
    if (payment.status !== "confirmed") {
      return res.status(400).json({ error: "payment_not_confirmed" });
    }
    let repo = null;
    if (repoId) {
      const repoResult = await pool.query(
        "SELECT * FROM repos WHERE id = $1 LIMIT 1",
        [repoId]
      );
      repo = repoResult.rows[0] || null;
    }
    if (!repo && owner && name) {
      repo = await getRepoByOwnerAndName(owner, name);
    }
    if (!repo) {
      if (!owner || !name) {
        return res.status(400).json({ error: "repo_identification_required" });
      }
      const newId = randomUUID();
      const insert = await pool.query(
        `
        INSERT INTO repos (id, name, owner, is_private, is_multisig, threshold, signers, payment_tx)
        VALUES ($1, $2, $3, false, true, $4, $5, $6)
        RETURNING *
      `,
        [newId, name, owner, computedThreshold, JSON.stringify(signerList), paymentTxSig]
      );
      repo = insert.rows[0];
    } else {
      await pool.query(
        `
        UPDATE repos
        SET is_multisig = true,
            threshold = $1,
            signers = $2,
            payment_tx = COALESCE(payment_tx, $3)
        WHERE id = $4
      `,
        [computedThreshold, JSON.stringify(signerList), paymentTxSig, repo.id]
      );
      const refreshed = await pool.query(
        "SELECT * FROM repos WHERE id = $1",
        [repo.id]
      );
      repo = refreshed.rows[0];
    }
    const multisigEntry = await ensureMultisigEntry(
      repo,
      pushTx,
      undefined
    );
    res.json({
      repo: formatRepoRow(repo),
      multisig: multisigEntry
        ? {
            status: multisigEntry.status,
            approvalsRequired: multisigEntry.approvals_required,
            approvalsCount: multisigEntry.approvals_count,
          }
        : null,
    });
  } catch (err: any) {
    res.status(400).json({
      error: "multisig_setup_failed",
      message: err?.message || String(err),
    });
  }
});

// Note: /upload removed - client uploads directly via Irys Web SDK

app.post("/push-log", async (req, res) => {
  const { txId, owner, repo, branch, encrypted } = req.body || {};
  if (!txId) {
    res.status(400).json({ error: "txId required" });
    return;
  }
  try {
    const pool = getPool();
    const repoRow = await getRepoByOwnerAndName(owner, repo);
    await pool.query(
      `
      INSERT INTO pushes (id, repo_id, tx_id, owner, repo, branch, encrypted)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tx_id) DO NOTHING
    `,
      [
        randomUUID(),
        repoRow?.id || null,
        txId,
        owner || null,
        repo || null,
        branch || null,
        Boolean(encrypted),
      ]
    );
    const multisigEntry = await ensureMultisigEntry(repoRow, txId, branch);
    res.json({
      ok: true,
      multisig: multisigEntry
        ? {
            status: multisigEntry.status,
            approvalsRequired: multisigEntry.approvals_required,
            approvalsCount: multisigEntry.approvals_count,
          }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: "DB insert failed" });
  }
});

app.get("/logs", async (req, res) => {
  const { owner, repo } = req.query as { owner?: string; repo?: string };
  let sql = "SELECT * FROM pushes";
  const params: any[] = [];
  const conditions: string[] = [];
  if (owner) {
    params.push(owner);
    conditions.push(`owner = $${params.length}`);
  }
  if (repo) {
    params.push(repo);
    conditions.push(`repo = $${params.length}`);
  }
  if (conditions.length) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY created_at DESC";
  try {
    const pool = getPool();
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "DB query failed" });
  }
});

app.get("/latest", async (req, res) => {
  const { repo, owner } = req.query as { repo?: string; owner?: string };
  if (!repo && !owner) {
    res.status(400).json({ error: "repo or owner required" });
    return;
  }
  let sql = "SELECT * FROM pushes";
  const params: any[] = [];
  const conditions: string[] = [];
  if (repo) {
    params.push(repo);
    conditions.push(`repo = $${params.length}`);
  }
  if (owner) {
    params.push(owner);
    conditions.push(`owner = $${params.length}`);
  }
  if (conditions.length) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY created_at DESC LIMIT 1";
  try {
    const pool = getPool();
    const result = await pool.query(sql, params);
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: "DB query failed" });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Permagit backend listening on port ${PORT}`);
});
