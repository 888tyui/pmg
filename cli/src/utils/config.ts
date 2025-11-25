import fs from "fs";
import os from "os";
import path from "path";
import dotenv from "dotenv";

const USER_DIR = path.join(os.homedir(), ".permagit");
const USER_CONFIG_PATH = path.join(USER_DIR, "config.json");

export interface UserConfig {
  keypairPath?: string;
  publicKey?: string;
  irysUrl?: string; // default node2.irys.xyz
  network?: "mainnet" | "devnet";
  backendUrl?: string;
  loginMethod?: "wallet" | "keypair";
  encryptionSigB64?: string; // base64 of detached signature for static message
  irysFundAddress?: string; // optional override for Irys fund destination
}

export function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function readUserConfig(): UserConfig {
  try {
    const raw = fs.readFileSync(USER_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as UserConfig;
  } catch {
    return {};
  }
}

export function writeUserConfig(config: UserConfig) {
  ensureDir(USER_DIR);
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function getRepoConfigPath(cwd = process.cwd()) {
  return path.join(cwd, ".permagit.json");
}

export interface RepoConfig {
  private?: boolean;
  repoId?: string;
  repoName?: string;
}

export function readRepoConfig(cwd = process.cwd()): RepoConfig {
  const p = getRepoConfigPath(cwd);
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as RepoConfig;
  } catch {
    return {};
  }
}

export function writeRepoConfig(partial: RepoConfig, cwd = process.cwd()) {
  const p = getRepoConfigPath(cwd);
  const current = readRepoConfig(cwd);
  const next = { ...current, ...partial };
  fs.writeFileSync(p, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export function getBackendUrl(): string {
  // Try to load .env from current working directory
  try {
    dotenv.config({ path: path.join(process.cwd(), ".env") });
  } catch {}
  const envUrl = process.env.PERMAGIT_BACKEND_URL;
  if (envUrl && envUrl.trim().length > 0) {
    return envUrl.trim().replace(/\/$/, '');
  }
  
  const cfg = readUserConfig();
  if (cfg.backendUrl && cfg.backendUrl.trim().length > 0) {
    return cfg.backendUrl.trim().replace(/\/$/, '');
  }
  
  return "https://api2.permagit.io";
}

export function getIrysFundAddress(): string | null {
  try {
    dotenv.config({ path: path.join(process.cwd(), ".env") });
  } catch {}
  const envAddr = process.env.PERMAGIT_IRYS_FUND_ADDRESS;
  if (envAddr && envAddr.trim().length > 0) return envAddr.trim();
  const cfg = readUserConfig();
  if (cfg.irysFundAddress && cfg.irysFundAddress.trim().length > 0)
    return cfg.irysFundAddress.trim();
  return null;
}
