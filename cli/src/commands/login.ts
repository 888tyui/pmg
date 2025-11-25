import { Command } from "commander";
import fs from "fs";
import path from "path";
import os from "os";
import chalk from "chalk";
import http from "http";
import crypto from "crypto";
import open from "open";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";
import { readUserConfig, writeUserConfig } from "../utils/config.js";

export default function registerLoginCommand(program: Command) {
  program
    .command("login")
    .description("Authenticate via browser wallet (Phantom).")
    .option("--keypair <path>", "Fallback: path to Solana keypair JSON")
    .action(async (opts: { keypair?: string }) => {
      if (opts.keypair) {
        // Fallback legacy keypair login (optional)
        const keypairPath = opts.keypair;
        if (!fs.existsSync(keypairPath)) {
          console.error(chalk.red(`Keypair file not found: ${keypairPath}`));
          process.exit(1);
        }
        try {
          const raw = fs.readFileSync(keypairPath, "utf-8");
          const arr = JSON.parse(raw);
          const secret = new Uint8Array(arr);
          // derive public key without importing @solana/web3.js in this path
          const { Keypair } = await import("@solana/web3.js");
          const kp = Keypair.fromSecretKey(secret);
          const publicKey = kp.publicKey.toBase58();
          const prev = readUserConfig();
          writeUserConfig({
            ...prev,
            keypairPath,
            publicKey,
            loginMethod: "keypair",
          });
          console.log(chalk.green("Login successful (keypair)"));
          console.log("You are logged in as:");
          console.log(chalk.cyan(publicKey));
          return;
        } catch (e: any) {
          console.error(chalk.red("Keypair login failed."));
          console.error(String(e?.message || e));
          process.exit(1);
        }
      }

      // React-based browser wallet login
      let doneResolve: (() => void) | null = null;
      const donePromise = new Promise<void>(
        (resolve) => (doneResolve = resolve)
      );

      // Build React UI bundle (LoginApp)
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const uiEntry = path.resolve(__dirname, "../../src/ui/LoginApp.tsx");
      // @ts-ignore
      const { build } = await import("esbuild");
      const req = createRequire(import.meta.url);
      const globalsPath = req.resolve("@esbuild-plugins/node-globals-polyfill");
      const stdlibPath = req.resolve("node-stdlib-browser");
      const globalsMod: any = await import(pathToFileURL(globalsPath).href);
      const NodeGlobalsPolyfillPlugin = globalsMod.NodeGlobalsPolyfillPlugin;
      const stdLibBrowserMod: any = await import(
        pathToFileURL(stdlibPath).href
      );
      const stdLibBrowser = stdLibBrowserMod.default || stdLibBrowserMod;
      const shimPath = req.resolve("node-stdlib-browser/helpers/esbuild/shim");
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
      });
      const jsOut = Buffer.from(built.outputFiles[0].contents).toString(
        "utf-8"
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
  <title>Permagit - Login</title>
  <style>
    :root {
      --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #c9d1d9; --muted: #8b949e;
      --green: #2ea043; --blue: #1f6feb; --red: #f85149; --badge-bg: #21262d;
    }
    * { box-sizing: border-box; } html, body { height: 100%; }
    body { margin: 0; background: var(--bg); color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }
    .gh-page { max-width: 720px; margin: 32px auto; padding: 0 20px; }
    .gh-header { display:flex; align-items:baseline; justify-content:space-between;
      margin-bottom:16px; border-bottom:1px solid var(--border); padding-bottom:12px; }
    .gh-title { font-size: 20px; font-weight: 700; }
    .gh-card { background: var(--panel); border:1px solid var(--border); border-radius:8px; padding:16px; }
    .steps { display:grid; grid-template-columns: repeat(4,1fr); gap:12px; margin-bottom:12px; }
    .step { display:flex; align-items:center; gap:8px; padding:10px 12px; border:1px solid var(--border);
      border-radius:8px; background:#0f141a; color:var(--muted); font-size:13px; }
    .dot { width:8px; height:8px; border-radius:999px; background:var(--muted); }
    .step.active { border-color:var(--blue); color:var(--text); } .step.active .dot{ background:var(--blue); }
    .step.done { border-color:var(--green); color:var(--text); } .step.done .dot{ background:var(--green); }
    .step.error { border-color:var(--red); color:var(--text); } .step.error .dot{ background:var(--red); }
    @keyframes spin { to{ transform: rotate(360deg); } } .spinner { width:16px;height:16px;border-radius:999px;
      border:2px solid var(--border); border-top-color:var(--blue); animation: spin .8s linear infinite; }
    .gh-log { margin:0; margin-top:8px; max-height:360px; overflow:auto; background:#0b0f14; border:1px solid var(--border);
      border-radius:8px; padding:12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace;
      font-size:12px; line-height:1.5; color:#9fb1c0; white-space:pre-wrap; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/buffer@6.0.3/index.min.js"></script>
  <script>
    if (typeof window !== 'undefined' && window.buffer && window.buffer.Buffer) {
      window.Buffer = window.buffer.Buffer;
      if (typeof globalThis !== 'undefined') globalThis.Buffer = window.buffer.Buffer;
    }
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
          if (req.method === "POST" && req.url === "/callback") {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
              try {
                const json = JSON.parse(body || "{}");
                const publicKey = String(json.publicKey || "");
                const signatureB64 = String(json.signature || "");
                if (!publicKey || !signatureB64) {
                  res.writeHead(400);
                  res.end("missing fields");
                  return;
                }
                const prev = readUserConfig();
                writeUserConfig({
                  ...prev,
                  publicKey,
                  loginMethod: "wallet",
                  encryptionSigB64: signatureB64,
                });
                res.writeHead(200);
                res.end("ok");
                console.log(chalk.green("Login successful (wallet)"));
                console.log("You are logged in as:");
                console.log(chalk.cyan(publicKey));
                try {
                  doneResolve && doneResolve();
                } catch {}
                setImmediate(() => {
                  try {
                    server.close();
                  } catch {}
                });
              } catch (e: any) {
                res.writeHead(500);
                res.end("error");
              }
            });
            return;
          }
          if (req.method === "POST" && req.url === "/irysaddr") {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
              try {
                const json = JSON.parse(body || "{}");
                const irysFundAddress = String(json.irysFundAddress || "");
                if (irysFundAddress) {
                  const prev = readUserConfig();
                  writeUserConfig({ ...prev, irysFundAddress });
                }
                res.writeHead(200);
                res.end("ok");
              } catch {
                res.writeHead(400);
                res.end("bad");
              }
            });
            return;
          }
          if (req.method === "POST" && req.url === "/done") {
            res.writeHead(200);
            res.end("ok");
            try {
              doneResolve && doneResolve();
            } catch {}
            setImmediate(() => {
              try {
                server.close();
              } catch {}
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
        typeof addr === "object" && addr && "port" in addr ? addr.port : 0;
      const url = `http://localhost:${port}/`;
      console.log(chalk.gray("Opening browser for wallet login..."));
      await open(url);

      // Wait until React app posts callback/done, do not wait for server 'close'
      await donePromise;
      process.exit(0);
    });
}
