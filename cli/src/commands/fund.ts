import { Command } from "commander";
import chalk from "chalk";
import http from "http";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import { createRequire } from "module";
import open from "open";
import {
  readUserConfig,
  getBackendUrl,
  writeUserConfig,
} from "../utils/config.js";

export default function registerFundCommand(program: Command) {
  program
    .command("fund")
    .description("Pre-fund your Irys balance via browser wallet (Phantom)")
    .option("--amount <sol>", "Amount in SOL to fund (optional)", "")
    .action(async (opts: { amount?: string }) => {
      try {
        const user = readUserConfig();
        if (!user.publicKey) {
          console.log(chalk.red("Not logged in. Run `permagit login` first."));
          process.exit(1);
        }
        const backendBase = getBackendUrl();
        const amount = opts.amount || "";

        // Build React UI bundle
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const uiEntry = path.resolve(__dirname, "../../src/ui/FundApp.tsx");
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

        let doneResolve: (() => void) | null = null;
        const donePromise = new Promise<void>(
          (resolve) => (doneResolve = resolve)
        );
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
      backendBase: ${JSON.stringify(String(backendBase))},
      amountSol: ${JSON.stringify(String(amount))}
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
                  server._result = j;
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
            if (req.method === "POST" && req.url === "/bundler") {
              let body = "";
              req.on("data", (c) => (body += c));
              req.on("end", () => {
                try {
                  const j = JSON.parse(body || "{}");
                  const url = String(j?.url || "");
                  if (url && /^https?:\/\//i.test(url)) {
                    const prev = readUserConfig();
                    writeUserConfig({ ...prev, irysUrl: url });
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
        console.log(chalk.gray("Opening browser for Irys funding..."));
        await open(url);
        await donePromise;
        const r = (server as any)._result || {};
        const amountSol = r.amountSol ? String(r.amountSol) : "";
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
        if (amountSol)
          console.log(
            `Amount: ${chalk.cyan(amountSol)} SOL  (${amountAtomic} atomic)`
          );
        if (before != null) console.log(`Balance before: ${String(before)}`);
        if (after != null)
          console.log(
            `Balance after:  ${String(after)}${delta ? `  (+${delta})` : ""}`
          );
        // Omit verbose fund result for cleaner UX
        process.exit(0);
      } catch (e: any) {
        console.error(chalk.red("Funding failed."));
        console.error(String(e?.message || e));
        process.exit(1);
      }
    });
}
