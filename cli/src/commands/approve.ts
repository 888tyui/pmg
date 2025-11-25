import { Command } from "commander";
import chalk from "chalk";
import http from "http";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";
import open from "open";
import { backendJson } from "../utils/http.js";
import {
  getRepoName,
  isGitRepo,
} from "../utils/git.js";
import { readRepoConfig, readUserConfig } from "../utils/config.js";

export default function registerApproveCommand(program: Command) {
  program
    .command("approve")
    .description("Approve a pending multisig push via wallet signature.")
    .requiredOption("--tx <txId>", "Target push transaction id")
    .option("--repo <name>", "Repository name (defaults to current repo)")
    .option("--owner <pubkey>", "Repository owner public key")
    .option("--repo-id <id>", "Repository id (optional)")
    .action(
      async (opts: {
        tx: string;
        repo?: string;
        owner?: string;
        "repo-id"?: string;
      }) => {
        if (!opts.tx) {
          console.error(chalk.red("--tx is required"));
          process.exit(1);
        }
        const repoCfg = readRepoConfig();
        const userCfg = readUserConfig();
        const repoId = opts["repo-id"] || repoCfg.repoId || undefined;
        let repoName = opts.repo;
        if (!repoId && !repoName) {
          if (isGitRepo()) {
            repoName = getRepoName();
          } else {
            console.error(
              chalk.red(
                "Repo name or id required. Pass --repo or run inside the repo directory."
              )
            );
            process.exit(1);
          }
        }
        const owner = opts.owner || userCfg.publicKey || undefined;

        // Build React UI bundle (ApproveApp)
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const uiEntry = path.resolve(__dirname, "../../src/ui/ApproveApp.tsx");
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

        let doneResolve: ((value?: void | PromiseLike<void>) => void) | null =
          null;
        const donePromise = new Promise<void>((resolve) => {
          doneResolve = resolve;
        });
        const server: any = http.createServer((req, res) => {
          try {
            if (!req.url) return;
            if (req.method === "GET" && req.url === "/") {
              const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Permagit - Approve Push</title>
  <style>
    body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0d1117; color:#c9d1d9; }
    .page { max-width:720px; margin:32px auto; padding:0 20px; }
    .card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:20px; }
    button { background:#238636; border:none; color:white; padding:12px 18px; border-radius:6px; font-size:15px; cursor:pointer; }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .log { margin-top:16px; font-family:monospace; white-space:pre-wrap; background:#0b0f14; border:1px solid #30363d; border-radius:8px; padding:12px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/buffer@6.0.3/index.min.js"></script>
  <script>
    if (typeof window !== 'undefined' && window.buffer && window.buffer.Buffer) {
      window.Buffer = window.buffer.Buffer;
      if (typeof globalThis !== 'undefined') globalThis.Buffer = window.buffer.Buffer;
    }
    window.__PERMAGIT__ = {
      txId: ${JSON.stringify(opts.tx)},
      repoName: ${JSON.stringify(repoName || null)},
      owner: ${JSON.stringify(owner || null)}
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
            if (req.method === "POST" && req.url === "/callback") {
              let body = "";
              req.on("data", (chunk) => (body += chunk));
              req.on("end", () => {
                try {
                  const json = JSON.parse(body || "{}");
                  server._approval = json;
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
              doneResolve && doneResolve();
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
          typeof addr === "object" && addr && "port" in addr
            ? (addr as any).port
            : 0;
        const url = `http://localhost:${port}/`;
        console.log(chalk.gray("Opening browser for wallet approval..."));
        await open(url);
        await donePromise;
        const approval = server._approval;
        if (!approval || !approval.signature || !approval.publicKey) {
          console.error(chalk.red("Approval signature missing from wallet."));
          process.exit(1);
        }
        console.log(chalk.gray("Submitting approval to backend..."));
        try {
          await backendJson("/multisig/approve", {
            body: {
              repoId,
              owner,
              name: repoName,
              txId: opts.tx,
              signer: approval.publicKey,
              signatureB64: approval.signature,
            },
          });
          console.log(chalk.green("Approval submitted successfully."));
        } catch (err: any) {
          console.error(chalk.red("Backend rejected approval."));
          console.error(chalk.red(err?.message || String(err)));
          process.exit(1);
        }
      }
    );
}

