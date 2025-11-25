import { Command } from "commander";
import chalk from "chalk";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import https from "https";
import http from "http";
import { readUserConfig } from "../utils/config.js";
import { Keypair } from "@solana/web3.js";
import {
  deriveAesKeyFromKeypair,
  deriveAesKeyFromSignatureB64,
  decryptAesGcm,
} from "../utils/crypto.js";
import { backendJson } from "../utils/http.js";

async function downloadToBuffer(
  url: string,
  redirectCount = 0
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(url, (res) => {
      const status = res.statusCode || 0;
      if (
        status >= 300 &&
        status < 400 &&
        res.headers.location &&
        redirectCount < 5
      ) {
        const next = new URL(res.headers.location, url).toString();
        res.resume(); // drain
        downloadToBuffer(next, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        const chunks: Buffer[] = [];
        res.on("data", (c) =>
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        );
        res.on("end", () => {
          const preview = Buffer.concat(chunks).toString("utf-8").slice(0, 200);
          reject(new Error(`HTTP ${status}${preview ? `: ${preview}` : ""}`));
        });
        res.on("error", reject);
        return;
      }
      const data: Buffer[] = [];
      res.on("data", (chunk) =>
        data.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      );
      res.on("end", () => resolve(Buffer.concat(data)));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

export default function registerCloneCommand(program: Command) {
  program
    .command("clone [txId] [targetDir]")
    .description("Clone repository snapshot from Arweave tx id.")
    .option(
      "--encrypted",
      "Indicate the bundle is encrypted (attempt decryption)"
    )
    .option("--otp <token>", "Redeem OTP token and auto-fetch bundle/decrypt key")
    .action(
      async (
        txIdArg: string | undefined,
        targetDir?: string,
        opts?: { encrypted?: boolean; otp?: string }
      ) => {
        let txId = txIdArg;
        let otpDecryptKeyB64: string | null = null;
        if (opts?.otp) {
          try {
            const redeemed = await backendJson<{
              bundleTx: string;
              decryptKey: string;
            }>("/otp/redeem", { body: { otp: opts.otp } });
            txId = redeemed.bundleTx;
            otpDecryptKeyB64 = redeemed.decryptKey || null;
            opts.encrypted = true;
            console.log(chalk.gray("OTP redeemed. Using secured bundle data."));
          } catch (err: any) {
            console.error(chalk.red("OTP redeem failed."));
            console.error(chalk.red(err?.message || String(err)));
            process.exit(1);
          }
        }
        if (!txId) {
          console.error(
            chalk.red("TxId is required (or provide --otp to fetch automatically).")
          );
          process.exit(1);
        }
        const gateway = "https://gateway.irys.xyz";
        const url = `${gateway}/${txId}`;
        console.log(chalk.gray(`Downloading ${url} ...`));
        let data: Buffer;
        try {
          data = await downloadToBuffer(url);
        } catch (e: any) {
          console.error(chalk.red("Failed to download data from gateway."));
          console.error(String(e?.message || e));
          process.exit(1);
        }
        if (opts?.encrypted) {
          try {
            const cfg = readUserConfig();
            let key: Buffer | null = null;
            if (otpDecryptKeyB64) {
              try {
                key = Buffer.from(otpDecryptKeyB64, "base64");
              } catch {
                throw new Error("Invalid decrypt key received from OTP.");
              }
            } else if (cfg.encryptionSigB64) {
              key = deriveAesKeyFromSignatureB64(cfg.encryptionSigB64);
            } else if (cfg.keypairPath) {
              const raw = fs.readFileSync(cfg.keypairPath, "utf-8");
              const arr = JSON.parse(raw);
              const secret = new Uint8Array(arr);
              const kp = Keypair.fromSecretKey(secret);
              key = deriveAesKeyFromKeypair(kp);
            } else {
              console.error(
                chalk.red(
                  "No encryption key available. Login first to configure wallet-based encryption or provide a keypair."
                )
              );
              process.exit(1);
            }
            if (data.length < 12 + 16 + 1) {
              throw new Error("encrypted payload too short");
            }
            // Try layout A (current): iv | tag | cipher
            const tryLayoutA = () => {
              const iv = data.subarray(0, 12);
              const tag = data.subarray(12, 28);
              const cipher = data.subarray(28);
              return decryptAesGcm(
                { iv, authTag: tag, ciphertext: cipher },
                key!
              );
            };
            // Try layout B (legacy): iv | cipher | tag
            const tryLayoutB = () => {
              const iv = data.subarray(0, 12);
              const tag = data.subarray(data.length - 16);
              const cipher = data.subarray(12, data.length - 16);
              return decryptAesGcm(
                { iv, authTag: tag, ciphertext: cipher },
                key!
              );
            };
            try {
              data = tryLayoutA();
            } catch {
              data = tryLayoutB();
            }
          } catch (e: any) {
            console.error(chalk.red("Decryption failed."));
            console.error(String(e?.message || e));
            console.error(
              chalk.gray(
                "Hints: 1) 로그인한 지갑으로 암호화 서명이 저장되어 있는지 확인(permagit login). 2) 예전 업로드면 레이아웃이 다를 수 있습니다. 3) 암호화가 아닌 데이터면 --encrypted 옵션을 제거하세요."
              )
            );
            process.exit(1);
          }
        }
        const tempDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "permagit-clone-")
        );
        const bundlePath = path.join(tempDir, "repo.bundle");
        fs.writeFileSync(bundlePath, data);
        const outDir = targetDir || "permagit-repo";
        try {
          execSync(`git clone "${bundlePath}" "${outDir}"`, {
            stdio: "inherit",
          });
        } catch (e: any) {
          console.error(chalk.red("Failed to clone from bundle."));
          process.exit(1);
        } finally {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {}
        }
      }
    );
}
