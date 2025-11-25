import http from "http";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";
import open from "open";

export interface PaymentPayload {
  txB64: string;
  owner: string;
  destination: string;
  mint: string;
  amountAtomic: string;
}

export async function openPaymentUi(payload: PaymentPayload): Promise<string> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const uiEntry = path.resolve(__dirname, "../../src/ui/PaymentApp.tsx");
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
  let signature: string | null = null;
  const donePromise = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });
  const server = http.createServer((req, res) => {
    try {
      if (!req.url) return;
      if (req.method === "GET" && req.url === "/") {
        const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Permagit - Payment</title>
  <style>
    body { margin:0; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#0d1117; color:#c9d1d9; }
    .page { max-width:720px; margin:32px auto; padding:0 20px; }
    .card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:20px; }
    button { padding:12px 18px; border-radius:6px; border:none; background:#238636; color:white; font-size:15px; cursor:pointer; }
    button:disabled { opacity:.5; cursor:not-allowed; }
    pre { background:#0b0f14; border:1px solid #30363d; border-radius:8px; padding:12px; font-family:ui-monospace, SFMono-Regular, Menlo; overflow:auto; }
  </style>
  <script src="https://unpkg.com/@solana/web3.js@1.95.0/lib/index.iife.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/buffer@6.0.3/index.min.js"></script>
  <script>
    if (typeof window !== 'undefined' && window.buffer && window.buffer.Buffer) {
      window.Buffer = window.buffer.Buffer;
      if (typeof globalThis !== 'undefined') globalThis.Buffer = window.buffer.Buffer;
    }
    window.__PERMAGIT__ = ${JSON.stringify(payload)};
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
      if (req.method === "POST" && req.url === "/signature") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const json = JSON.parse(body || "{}");
            signature = String(json.signature || "");
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
        setImmediate(() => {
          try {
            server.close();
          } catch {}
        });
        doneResolve && doneResolve();
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
    typeof addr === "object" && addr && "port" in addr ? (addr as any).port : 0;
  const url = `http://localhost:${port}/`;
  console.log("Opening browser for payment approval...");
  await open(url);
  await donePromise;
  if (!signature) {
    throw new Error("payment_signature_missing");
  }
  return signature;
}

