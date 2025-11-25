import { Command } from "commander";
import chalk from "chalk";
import { isGitRepo, getCurrentBranch, getRepoName } from "../utils/git.js";
import {
  readRepoConfig,
  getBackendUrl,
  readUserConfig,
  writeRepoConfig,
} from "../utils/config.js";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import https from "https";
import http from "http";
import open from "open";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";
import readline from "readline";
import { backendJson } from "../utils/http.js";
import { openPaymentUi } from "../utils/paymentUi.js";

async function postPushLog(payload: any) {
  try {
    const backendUrl = getBackendUrl();
    const url = new URL("/push-log", backendUrl);
    await new Promise<void>((resolve, reject) => {
      const isHttps = url.protocol === "https:";
      const client = isHttps ? https : http;
      const req = client.request(
        {
          method: "POST",
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          headers: {
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", resolve);
        }
      );
      req.on("error", reject);
      req.write(JSON.stringify(payload));
      req.end();
    });
  } catch {
    // ignore failures for logging
  }
}

function parseOwners(input?: string): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

async function promptInput(question: string, defaultValue?: string) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const promptText = defaultValue
    ? `${question} (${defaultValue}): `
    : `${question}: `;
  return await new Promise<string>((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed.length ? trimmed : defaultValue || "");
    });
  });
}

export default function registerPushCommand(program: Command) {
  program
    .command("push")
    .description(
      "Bundle current git repo and upload to Arweave via Irys (encrypt if private)."
    )
    .option(
      "--multisig-owners <pubkeys>",
      "Comma-separated list of public keys that must approve pushes"
    )
    .option(
      "--multisig-threshold <n>",
      "Number of multisig approvals required (defaults to ceil(len/2))"
    )
    .action(async (opts: { multisigOwners?: string; multisigThreshold?: string }) => {
      if (!isGitRepo()) {
        console.error(chalk.red("This directory is not a Git repository."));
        process.exit(1);
      }
      let repoCfg = readRepoConfig();
      const userCfg = readUserConfig();
      const backendBase = getBackendUrl();
      const multisigOwners = parseOwners(opts.multisigOwners);
      const multisigThreshold =
        typeof opts.multisigThreshold === "string"
          ? Number(opts.multisigThreshold)
          : undefined;
      repoCfg = await ensureRepoRegistered({
        repoCfg,
        userCfg,
      });
      // Auto-commit uncommitted changes before bundling
      try {
        const status = execSync("git status --porcelain", {
          cwd: process.cwd(),
        })
          .toString()
          .trim();
        if (status.length > 0) {
          console.log(
            chalk.gray("Detected working tree changes. Creating auto-commit...")
          );
          execSync("git add -A", { stdio: "inherit" });
          const ts = new Date().toISOString();
          const msg = `permagit: auto-commit ${ts}`;
          try {
            execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, {
              stdio: "inherit",
            });
          } catch {
            // Fallback with inline identity if user.name/email not configured
            execSync(
              `git -c user.name=permagit -c user.email=permagit@local commit -m "${msg.replace(
                /"/g,
                '\\"'
              )}"`,
              { stdio: "inherit" }
            );
          }
          try {
            const head = execSync("git rev-parse --short HEAD")
              .toString()
              .trim();
            console.log(chalk.gray(`Auto-commit created at ${head}`));
          } catch {}
        }
      } catch {
        // ignore auto-commit errors; proceed to bundle
      }
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "permagit-"));
      const bundlePath = path.join(tempDir, "repo.bundle");
      try {
        execSync(`git bundle create "${bundlePath}" --all`, {
          stdio: "inherit",
        });
      } catch (e: any) {
        console.error(chalk.red("Failed to create git bundle."));
        process.exit(1);
      }
      let data = fs.readFileSync(bundlePath);
      // Encryption will be handled in the browser page if needed
      let encrypted = repoCfg.private ? true : false;
      try {
        const tags = [
          { name: "Content-Type", value: "application/octet-stream" },
          { name: "App-Name", value: "Permagit" },
          { name: "Repo-Name", value: getRepoName() },
          { name: "Branch", value: getCurrentBranch() },
          { name: "Encrypted", value: encrypted ? "true" : "false" },
        ];
        if (repoCfg.private && !userCfg.encryptionSigB64) {
          console.error(
            chalk.red(
              'Private repository: Not logged in. Run "permagit login" first to save encryption signature.'
            )
          );
          process.exit(1);
        }
        // Build React UI bundle with esbuild and serve locally
        const uiEntry = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../src/ui/PushApp.tsx"
        );
        // @ts-ignore - resolve at runtime
        const { build } = await import("esbuild");
        const req = createRequire(import.meta.url);
        const globalsPath = req.resolve(
          "@esbuild-plugins/node-globals-polyfill"
        );
        const stdlibPath = req.resolve("node-stdlib-browser");
        const globalsMod: any = await import(pathToFileURL(globalsPath).href);
        const NodeGlobalsPolyfillPlugin = globalsMod.NodeGlobalsPolyfillPlugin;
        const stdLibBrowserMod: any = await import(
          pathToFileURL(stdlibPath).href
        );
        const stdLibBrowser = stdLibBrowserMod.default || stdLibBrowserMod;
        const shimPath = req.resolve(
          "node-stdlib-browser/helpers/esbuild/shim"
        );
        const coreAliasPlugin = {
          name: "core-alias",
          setup(b: any) {
            const aliasMap: Record<string, string> = stdLibBrowser as any;
            const keys = Object.keys(aliasMap);
            const re = new RegExp(
              `^(${keys.map((k) => k.replace(/[-/]/g, "\\$&")).join("|")})$`
            );
            b.onResolve({ filter: re }, (args: any) => {
              try {
                const targetPath = aliasMap[args.path];
                if (!targetPath) return null;
                const absPath = req.resolve(targetPath);
                return { path: absPath };
              } catch {
                return null;
              }
            });
          },
        };
        const cliRoot = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../../"
        );
        const built = await build({
          entryPoints: [uiEntry],
          bundle: true,
          write: false,
          platform: "browser",
          target: ["es2020"],
          jsx: "automatic",
          format: "iife",
          mainFields: ["browser", "module", "main"],
          conditions: ["browser", "default"],
          define: {
            "process.env.NODE_ENV": '"production"',
            global: "window",
          },
          inject: [shimPath],
          plugins: [
            coreAliasPlugin,
            NodeGlobalsPolyfillPlugin({
              process: true,
              buffer: true,
            }),
          ],
          absWorkingDir: cliRoot,
          sourcemap: false,
          minify: false,
        });
        const jsOut =
          built.outputFiles.find((f: any) => f.path.endsWith(".js"))?.text ||
          built.outputFiles[0]?.text ||
          "";
        let doneResolve: (() => void) | null = null;
        const donePromise = new Promise<void>(
          (resolve) => (doneResolve = resolve)
        );
        const server = http.createServer((req, res) => {
          try {
            if (!req.url) return;
            if (req.method === "GET" && req.url === "/") {
              const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Permagit - Push Upload</title>
  <style>
    :root {
      --bg: #0d1117;
      --panel: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --muted: #8b949e;
      --green: #2ea043;
      --blue: #1f6feb;
      --red: #f85149;
      --yellow: #d29922;
      --badge-bg: #21262d;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
    }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .gh-page { max-width: 880px; margin: 32px auto; padding: 0 20px; }
    .gh-header {
      display: flex; align-items: baseline; justify-content: space-between;
      margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 12px;
    }
    .gh-title { font-size: 20px; font-weight: 700; }
    .gh-sub { display: flex; gap: 8px; align-items: center; }
    .badge {
      display: inline-flex; gap: 6px; align-items: center;
      padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px;
      background: var(--badge-bg); color: var(--text); font-size: 12px;
    }
    .badge-lock { border-color: #5b636a; background: #1b1f24; }
    .badge-green { border-color: var(--green); color: #8df0b4; }

    .gh-card {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px;
    }
    .steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 12px; }
    .step {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: #0f141a;
      color: var(--muted); font-size: 13px;
    }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--muted); }
    .step.active { border-color: var(--blue); color: var(--text); }
    .step.active .dot { background: var(--blue); }
    .step.done { border-color: var(--green); color: var(--text); }
    .step.done .dot { background: var(--green); }
    .step.error { border-color: var(--red); color: var(--text); }
    .step.error .dot { background: var(--red); }

    @keyframes pulse {
      0% { opacity: .35; }
      50% { opacity: 1; }
      100% { opacity: .35; }
    }
    .step.active .dot { animation: pulse 1.1s ease-in-out infinite; }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .spinner {
      width: 16px; height: 16px; border-radius: 999px;
      border: 2px solid var(--border); border-top-color: var(--blue);
      animation: spin .8s linear infinite;
    }
    .spinner.green { border-top-color: var(--green); }

    .gh-log {
      margin: 0; margin-top: 8px; max-height: 380px; overflow: auto;
      background: #0b0f14; border: 1px solid var(--border); border-radius: 8px;
      padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 12px; line-height: 1.5; color: #9fb1c0; white-space: pre-wrap;
    }

    .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
  </style>
  <script src="https://unpkg.com/@solana/web3.js@1.95.0/lib/index.iife.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/buffer@6.0.3/index.min.js"></script>
  <script>
    // Force Buffer polyfill globally for all modules
    if (typeof window !== 'undefined' && window.buffer && window.buffer.Buffer) {
      window.Buffer = window.buffer.Buffer;
      if (typeof globalThis !== 'undefined') globalThis.Buffer = window.buffer.Buffer;
    }
    window.__PERMAGIT__ = {
      dataB64: ${JSON.stringify(data.toString("base64"))},
      tags: ${JSON.stringify(tags)},
      isPrivate: ${repoCfg.private ? "true" : "false"},
      backendBase: ${JSON.stringify(String(backendBase))},
      encryptionSigB64: ${JSON.stringify(
        String(userCfg.encryptionSigB64 || "")
      )}
    };
  </script>
</head>
<body>
  <div id="root"></div>
  <script src="/app.js"></script>
</body>
</html>`;
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(html);
              return;
            }
            if (req.method === "GET" && req.url === "/app.js") {
              res.writeHead(200, { "Content-Type": "application/javascript" });
              res.end(jsOut);
              return;
            }
            if (req.method === "POST" && req.url === "/done") {
              let body = "";
              req.on("data", (c) => (body += c));
              req.on("end", async () => {
                try {
                  const j = JSON.parse(body || "{}");
                  const txId = j.txId || "";
                  if (!txId) throw new Error("missing txId");
                  (server as any)._txId = txId;
                  res.writeHead(200);
                  res.end("ok");
                  // signal CLI immediately; browser can close independently
                  try {
                    doneResolve && doneResolve();
                  } catch {}
                  // then close server asynchronously
                  setImmediate(() => server.close());
                } catch {
                  res.writeHead(400);
                  res.end("bad");
                }
              });
              return;
            }
            res.writeHead(404);
            res.end("not found");
          } catch {
            res.writeHead(500);
            res.end("error");
          }
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", () => resolve())
        );
        const addr = server.address();
        const port =
          typeof addr === "object" && addr && "port" in addr
            ? (addr as any).port
            : 0;
        const url = `http://localhost:${port}/`;
        console.log(chalk.gray("Opening browser for wallet upload..."));
        await open(url);
        // wait for /done signal rather than server 'close' to avoid delay
        await donePromise;
        // ensure server is closing, but do not wait for the event
        try {
          server.close();
        } catch {}
        const txId = (server as any)._txId as string | undefined;
        if (txId) {
          const repo = getRepoName();
          const branch = getCurrentBranch();
          const visibility = encrypted ? "Private" : "Public";
          const sizeKb = (data.length / 1024).toFixed(1);
          const gateway = `https://gateway.irys.xyz/${txId}`;

          console.log("");
          console.log(chalk.green("✔ Push complete"));
          console.log(
            `Repo: ${chalk.cyan(repo)}  Branch: ${chalk.cyan(
              branch
            )}  Visibility: ${visibility}`
          );
          console.log(`Bundle size: ${sizeKb} KB`);
          console.log(`TxID: ${chalk.cyan(txId)}`);
          console.log(`Gateway: ${chalk.underline(gateway)}`);

          // Ensure push log is persisted before exit (with short timeout)
          try {
            await Promise.race([
              postPushLog({
                action: "push",
                repo,
                branch,
                txId,
                encrypted,
                owner:
                  userCfg && userCfg.publicKey
                    ? String(userCfg.publicKey)
                    : null,
              }),
              new Promise<void>((resolve) => setTimeout(resolve, 1200)),
            ]);
          } catch {}
          if (multisigOwners.length) {
            try {
              await handleMultisigFlow({
                owners: multisigOwners,
                threshold: multisigThreshold,
                repoCfg,
                userCfg,
                repoName: repo,
                pushTx: txId,
              });
            } catch (err: any) {
              console.error(
                chalk.red(
                  `Multisig setup failed: ${err?.message || String(err)}`
                )
              );
            }
          }
        }
        // Browser flow finished: clean up and exit CLI
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
        process.exit(0);
      } catch (e: any) {
        console.error(chalk.red("Upload failed."));
        console.error(String(e?.message || e));
        process.exit(1);
      } finally {
        // no-op; cleanup handled before exit on success
      }
    });
}

async function handleMultisigFlow({
  owners,
  threshold,
  repoCfg,
  userCfg,
  repoName,
  pushTx,
}: {
  owners: string[];
  threshold?: number;
  repoCfg: { repoId?: string };
  userCfg: { publicKey?: string };
  repoName: string;
  pushTx: string;
}) {
  const ownerPk = userCfg.publicKey;
  if (!ownerPk) {
    throw new Error("Not logged in. Run `permagit login` first.");
  }
  const uniqueOwners = Array.from(new Set(owners.map((o) => o.trim()).filter(Boolean)));
  if (!uniqueOwners.includes(ownerPk)) {
    uniqueOwners.push(ownerPk);
  }
  console.log(chalk.gray("Preparing multisig payment transaction..."));
  const payment = await backendJson<{
    txB64: string;
    amountAtomic: string;
    destination: string;
    mint: string;
  }>("/payments/create", {
    body: { payer: ownerPk, purpose: "multisig_setup" },
  });
  const paymentSig = await openPaymentUi({
    txB64: payment.txB64,
    owner: ownerPk,
    destination: payment.destination,
    mint: payment.mint,
    amountAtomic: payment.amountAtomic,
  });
  if (!paymentSig) {
    throw new Error("wallet_signature_missing");
  }
  console.log(chalk.gray("Confirming payment on backend..."));
  await backendJson("/payments/verify", {
    body: {
      txSig: paymentSig,
      payer: ownerPk,
      purpose: "multisig_setup",
      repoName,
    },
  });
  await backendJson("/multisig/setup", {
    body: {
      repoId: repoCfg.repoId || undefined,
      owner: ownerPk,
      name: repoName,
      pushTx,
      signers: uniqueOwners,
      threshold,
      paymentTxSig: paymentSig,
    },
  });
  console.log(
    chalk.green("Multisig registered. Waiting for owners to approve push.")
  );
}

async function ensureRepoRegistered({
  repoCfg,
  userCfg,
}: {
  repoCfg: { repoId?: string; repoName?: string; private?: boolean };
  userCfg: { publicKey?: string };
}) {
  if (repoCfg.repoId) return repoCfg;
  const ownerPk = userCfg.publicKey;
  if (!ownerPk) {
    throw new Error("Not logged in. Run `permagit login` first.");
  }
  const defaultName = repoCfg.repoName || getRepoName();
  const repoName = await promptInput(
    "Enter repository name for Permagit",
    defaultName
  );
  if (!repoName) {
    throw new Error("Repository name is required.");
  }
  console.log(chalk.gray("Registering repository on backend..."));
  const result = await backendJson<{
    repo: { id: string; isPrivate: boolean };
  }>("/repos", {
    body: {
      name: repoName,
      owner: ownerPk,
      isPrivate: Boolean(repoCfg.private),
      signers: [],
      threshold: undefined,
      paymentTxSig: undefined,
    },
  });
  const updated = writeRepoConfig(
    { repoId: result.repo.id, repoName, private: repoCfg.private },
    process.cwd()
  );
  console.log(
    chalk.green(`Repo registered on backend as "${repoName}" (${result.repo.id})`)
  );
  return updated;
}

