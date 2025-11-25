import Irys from "@irys/sdk";
import { readUserConfig } from "./config.js";
import fs from "fs";
import https from "https";
import http from "http";

export interface IrysClientConfig {
  url: string; // e.g., https://node2.irys.xyz
  token: "solana";
  keypair: Uint8Array; // Solana secret key
}

export async function createIrysClient() {
  const cfg = readUserConfig();
  if (!cfg.keypairPath) {
    throw new Error("Not logged in. Run `permagit login` first.");
  }
  const raw = fs.readFileSync(cfg.keypairPath, "utf-8");
  const arr = JSON.parse(raw);
  const secret = new Uint8Array(arr);
  const url = cfg.irysUrl || "https://node2.irys.xyz";
  // Note: Irys Node SDK API may differ by version; this is a best-effort initialization.
  const irys = await (Irys as any)({
    url,
    token: "solana",
    keypair: secret,
  });
  return irys;
}

export function getIrysBaseUrl(): string {
  const cfg = readUserConfig();
  return cfg.irysUrl || "https://node2.irys.xyz";
}

export async function fetchIrysBalanceByAddress(
  publicKey: string
): Promise<string> {
  // Try multiple nodes to avoid mismatch with the node used by the Web SDK
  const bases: string[] = [];
  try {
    const baseCfg = getIrysBaseUrl();
    if (baseCfg) bases.push(baseCfg);
  } catch {}
  // De-duplicate and add common candidates
  for (const b of [
    "https://uploader.irys.xyz",
    "https://node2.irys.xyz",
    "https://node1.irys.xyz",
  ]) {
    if (!bases.includes(b)) bases.push(b);
  }

  let best: string | null = null;
  let bestNum: bigint = BigInt(-1);

  const tryOne = (base: string) =>
    new Promise<string>((resolve) => {
      try {
        const clean = base.replace(/\/+$/g, "");
        // Try multiple endpoint shapes in order
        const paths = [
          `/account/balance?address=${encodeURIComponent(
            publicKey
          )}&token=solana`,
          `/account/balance/${encodeURIComponent(publicKey)}?token=solana`,
          `/account/balance/${encodeURIComponent(publicKey)}`,
          `/account/balance/solana?address=${encodeURIComponent(publicKey)}`,
        ];

        const doFetch = (pathStr: string) =>
          new Promise<string>((res2) => {
            try {
              const url = new URL(pathStr, clean);
              const isHttps = url.protocol === "https:";
              const client = isHttps ? https : http;
              const req = client.request(
                {
                  method: "GET",
                  hostname: url.hostname,
                  port: url.port || (isHttps ? 443 : 80),
                  path: `${url.pathname}${url.search}`,
                },
                (res) => {
                  let body = "";
                  res.on("data", (c) => (body += c));
                  res.on("end", () => {
                    try {
                      const j = JSON.parse(body);
                      const raw =
                        j?.balance ??
                        j?.available ??
                        j?.funds ??
                        j?.quantity ??
                        j?.data ??
                        null;
                      if (raw == null) return res2("unknown");
                      res2(String(raw));
                    } catch {
                      // Fallback: return raw text
                      res2(body || "unknown");
                    }
                  });
                }
              );
              req.on("error", () => res2("unknown"));
              req.end();
            } catch {
              res2("unknown");
            }
          });

        (async () => {
          let bestLocal: string | null = null;
          let bestLocalNum: bigint = BigInt(-1);
          for (const p of paths) {
            const v = await doFetch(p);
            const s = String(v || "");
            if (/^[0-9]+$/.test(s)) {
              const n = BigInt(s);
              if (n > bestLocalNum) {
                bestLocalNum = n;
                bestLocal = s;
              }
            }
          }
          if (bestLocal != null) return resolve(bestLocal);
          resolve("unknown");
        })();
      } catch {
        resolve("unknown");
      }
    });

  for (const base of bases) {
    const val = await tryOne(base);
    const s = String(val || "");
    if (/^[0-9]+$/.test(s)) {
      const n = BigInt(s);
      if (n > bestNum) {
        bestNum = n;
        best = s;
      }
    }
    // Short-circuit if we already have a positive balance
    if (bestNum > BigInt(0)) break;
  }
  if (best != null) return best;
  return "unknown";
}
