import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool() {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL (or POSTGRES_URL) is required for Postgres connection."
      );
    }
    pool = new Pool({
      connectionString,
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }
  return pool;
}

export async function initSchema() {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        tx_sig TEXT UNIQUE NOT NULL,
        payer TEXT NOT NULL,
        purpose TEXT NOT NULL,
        token_amount_atomic NUMERIC NOT NULL,
        usd_value NUMERIC,
        status TEXT NOT NULL DEFAULT 'pending',
        repo_name TEXT,
        consumed_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        is_private BOOLEAN DEFAULT FALSE,
        is_multisig BOOLEAN DEFAULT FALSE,
        threshold INTEGER,
        signers JSONB DEFAULT '[]'::JSONB,
        payment_tx TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(owner, name)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS pushes (
        id TEXT PRIMARY KEY,
        repo_id TEXT REFERENCES repos(id),
        tx_id TEXT UNIQUE NOT NULL,
        owner TEXT,
        repo TEXT,
        branch TEXT,
        encrypted BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS otp_tokens (
        id TEXT PRIMARY KEY,
        repo_id TEXT REFERENCES repos(id),
        payment_tx TEXT,
        otp_plain TEXT NOT NULL,
        decrypt_key TEXT NOT NULL,
        bundle_tx TEXT NOT NULL,
        expires_at TIMESTAMPTZ,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS multisig_pushes (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id),
        push_tx TEXT NOT NULL,
        branch TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        approvals_required INTEGER NOT NULL,
        approvals_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        approved_at TIMESTAMPTZ,
        UNIQUE(repo_id, push_tx)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS multisig_signatures (
        id TEXT PRIMARY KEY,
        multisig_push_id TEXT REFERENCES multisig_pushes(id) ON DELETE CASCADE,
        signer TEXT NOT NULL,
        signature_b64 TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(multisig_push_id, signer)
      )
    `);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
