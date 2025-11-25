import { Command } from "commander";
import chalk from "chalk";
import {
  createIrysClient,
  fetchIrysBalanceByAddress,
  getIrysBaseUrl,
} from "../utils/irys.js";
import { readUserConfig, getBackendUrl } from "../utils/config.js";
import http from "http";
import open from "open";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

export default function registerIrysCommand(program: Command) {
  const irys = new Command("irys").description(
    "Irys (bundle/payment) status and funding"
  );

  irys
    .option("--status", "Show current Irys balance from stored login publicKey")
    .option("--fund <amount>", "Fund Irys account with SOL (e.g., 0.1)")
    .option("--wallet", "Force wallet-adapter funding via browser")
    .action(
      async (opts: { status?: boolean; fund?: string; wallet?: boolean }) => {
        try {
          const client: any = await createIrysClient().catch(() => null);
          if (opts.status) {
            const cfg = readUserConfig();
            if (!cfg.publicKey) {
              console.log(
                chalk.red("Not logged in. Run `permagit login` first.")
              );
              process.exit(1);
            }
            const bal = await fetchIrysBalanceByAddress(cfg.publicKey).catch(
              () => "unknown"
            );
            console.log(chalk.green("Irys balance (by address)"));
            console.log(`Address: ${chalk.cyan(cfg.publicKey)}`);
            console.log(`Balance: ${chalk.cyan(String(bal))}`);
            return;
          }
          if (opts.fund) {
            const amount = Number(opts.fund);
            if (!Number.isFinite(amount) || amount <= 0) {
              console.log(chalk.red("Invalid amount."));
              process.exit(1);
            }
            // If --wallet or no local keypair, open browser wallet funding flow
            const hasKeypair = Boolean(readUserConfig().keypairPath);
            if (opts.wallet || !client || !hasKeypair) {
              await walletFundFlow(amount, client);
              return;
            } else {
              // convert SOL to atomic if available
              const atomic = client.utils?.toAtomic
                ? client.utils.toAtomic(amount)
                : amount;
              const res = await client.fund(atomic);
              console.log(chalk.green("Irys funding request sent"));
              console.log(chalk.gray(JSON.stringify(res)));
              return;
            }
          }
          irys.help();
        } catch (e: any) {
          console.error(chalk.red("Irys operation failed."));
          console.error(String(e?.message || e));
          process.exit(1);
        }
      }
    );

  program.addCommand(irys);
}

async function walletFundFlow(amountSol: number, client: any) {
  // Use the new React FundApp to ensure consistent UI/UX
  const backendBase = getBackendUrl();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const uiEntry = path.resolve(__dirname, "../../src/ui/FundApp.tsx");
  // @ts-ignore
  const { build } = await import("esbuild");
  const req = createRequire(import.meta.url);
  const globalsPath = req.resolve("@esbuild-plugins/node-globals-polyfill");
  const stdlibPath = req.resolve("node-stdlib-browser");
  const globalsMod: any = await import(pathToFileURL(globalsPath).href);
  const NodeGlobalsPolyfillPlugin = globalsMod.NodeGlobalsPolyfillPlugin;
  const stdLibBrowserMod: any = await import(pathToFileURL(stdlibPath).href);
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
  const jsOut = Buffer.from(built.outputFiles[0].contents).toString("utf-8");

  let doneResolve: (() => void) | null = null;
  const donePromise = new Promise<void>((resolve) => (doneResolve = resolve));
  const server: any = http.createServer((req, res) => {
    try {
      if (!req.url) return;
      if (req.method === "GET" && req.url === "/") {
        const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Permagit - Fund</title>
  <style>
    :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --text:#c9d1d9; --muted:#8b949e; --blue:#1f6feb; --green:#2ea043; }
    *{box-sizing:border-box} html,body{height:100%} body{margin:0;background:var(--bg);color:var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;}
    .gh-page{max-width:720px;margin:32px auto;padding:0 20px}
    .gh-header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:12px}
    .gh-title{font-size:20px;font-weight:700}
    .gh-card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px}
    .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px}
    .step{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:#0f141a;color:var(--muted);font-size:13px}
    .dot{width:8px;height:8px;border-radius:999px;background:var(--muted)}
    .step.active{border-color:var(--blue);color:var(--text)} .step.active .dot{background:var(--blue)}
    .step.done{border-color:var(--green);color:var(--text)} .step.done .dot{background:var(--green)}
    .step.error{border-color:#f85149;color:var(--text)} .step.error .dot{background:#f85149}
    @keyframes pulse{0%{opacity:.35}50%{opacity:1}100%{opacity:.35}}
    .step.active .dot{animation:pulse 1.1s ease-in-out infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .spinner{width:16px;height:16px;border-radius:999px;border:2px solid var(--border);border-top-color:var(--blue);animation:spin .8s linear infinite}
    .gh-log{margin:0;margin-top:8px;max-height:360px;overflow:auto;background:#0b0f14;border:1px solid var(--border);border-radius:8px;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Courier New',monospace;font-size:12px;line-height:1.5;color:#9fb1c0;white-space:pre-wrap}
  </style>
  <script src="https://cdn.jsdelivr.net/npm/buffer@6.0.3/index.min.js"></script>
  <script>
    if (typeof window !== 'undefined' && window.buffer && window.buffer.Buffer) {
      window.Buffer = window.buffer.Buffer;
      if (typeof globalThis !== 'undefined') globalThis.Buffer = window.buffer.Buffer;
    }
    window.__PERMAGIT__ = {
      backendBase: ${JSON.stringify(String(getBackendUrl()))},
      amountSol: ${JSON.stringify(String(amountSol || ""))}
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
        req.on("end", () => {
          try {
            const j = JSON.parse(body || "{}");
            (server as any)._result = j;
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
    typeof addr === "object" && addr && "port" in addr ? addr.port : 0;
  const url = `http://localhost:${port}/`;
  console.log(chalk.gray("Opening browser for wallet funding..."));
  await open(url);
  await donePromise;
  const r = (server as any)._result || {};
  const amountSolStr = r.amountSol ? String(r.amountSol) : "";
  const amountAtomic = r.amountAtomic ? String(r.amountAtomic) : "";
  const before = r.balanceBefore ?? null;
  const after = r.balanceAfter ?? null;
  const delta =
    before != null &&
    after != null &&
    /^[0-9]+$/.test(String(before)) &&
    /^[0-9]+$/.test(String(after))
      ? (BigInt(String(after)) - BigInt(String(before))).toString()
      : "";
  console.log("");
  console.log(chalk.green("✔ Funding complete"));
  if (amountSolStr)
    console.log(
      `Amount: ${chalk.cyan(amountSolStr)} SOL  (${amountAtomic} atomic)`
    );
  if (before != null) console.log(`Balance before: ${String(before)}`);
  if (after != null)
    console.log(
      `Balance after:  ${String(after)}${delta ? `  (+${delta})` : ""}`
    );
  // Omit verbose fund result for cleaner UX and exit promptly
  process.exit(0);
}

// walletStatusFlow removed: status now uses stored login publicKey only.
