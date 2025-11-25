// @ts-nocheck
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Buffer as BufferPolyfill } from "buffer";
import { WebUploader } from "@irys/web-upload";
import { WebSolana } from "@irys/web-upload-solana";

declare global {
  interface Window {
    solana: any;
    solanaWeb3: any;
    __PERMAGIT__?: {
      dataB64: string;
      tags: { name: string; value: string }[];
      isPrivate: boolean;
      backendBase: string;
    };
  }
}

const App: React.FC = () => {
  const [log, setLog] = useState<string>("");
  const [step, setStep] = useState<
    "init" | "wallet" | "fund" | "upload" | "done" | "error"
  >("init");
  const add = (m: string) => setLog((v) => v + (v ? "\n" : "") + m);

  useEffect(() => {
    (async () => {
      try {
        if (
          typeof window !== "undefined" &&
          (!window.Buffer || typeof window.Buffer.from !== "function")
        ) {
          // ensure Buffer.from exists
          // @ts-ignore
          window.Buffer = BufferPolyfill;
        }
        const payload = window.__PERMAGIT__;
        if (!payload) {
          add("Payload missing.");
          return;
        }
        const { dataB64, tags, isPrivate, backendBase } = payload;
        const repoName = Array.isArray(tags)
          ? tags.find((t) => t.name === "Repo-Name")?.value || ""
          : "";
        const branchName = Array.isArray(tags)
          ? tags.find((t) => t.name === "Branch")?.value || ""
          : "";
        const provider = window.solana;
        if (!provider || !provider.isPhantom) {
          add("Phantom wallet not detected.");
          return;
        }
        add("Initializing upload...");
        setStep("wallet");
        await provider.connect();
        if (!provider.publicKey) {
          add("Wallet connection failed: publicKey not available.");
          setStep("error");
          return;
        }
        try {
          add("Wallet connected: " + (provider.publicKey?.toBase58?.() || ""));
        } catch {}

        add("Loading Irys Web SDK (local)...");
        // Prefer configuring SDK with backend RPC if supported
        let builder: any = WebUploader(WebSolana);
        try {
          const rpcUrl = backendBase + "/solana/rpc";
          if (builder && typeof builder.withRpc === "function") {
            builder = builder.withRpc(rpcUrl);
            add("SDK RPC configured via withRpc.");
          } else if (builder && typeof builder.withConfig === "function") {
            builder = builder.withConfig({ rpcUrl });
            add("SDK RPC configured via withConfig.");
          }
        } catch {}
        // Shim wallet to provide sendTransaction expected by SDK
        const walletShim: any = {
          get publicKey() {
            return provider.publicKey;
          },
          signTransaction: (tx: any) => provider.signTransaction(tx),
          signAllTransactions: (txs: any[]) =>
            provider.signAllTransactions
              ? provider.signAllTransactions(txs)
              : Promise.all(txs.map((t) => provider.signTransaction(t))),
          // Irys Web Solana may require message signing
          signMessage: async (message: Uint8Array) => {
            if (typeof provider.signMessage === "function") {
              const res = await provider.signMessage(message, "utf8");
              // Normalize to Uint8Array if wallet returns { signature }
              // Phantom returns { signature: Uint8Array }
              const sig = (res && (res.signature || res)) as Uint8Array;
              return sig;
            }
            throw new Error("signMessage not supported by wallet");
          },
          sendTransaction: async (tx: any, connection: any, options?: any) => {
            const signed = await provider.signTransaction(tx);
            const raw = signed.serialize();
            // Try using provided connection (already proxied) first
            try {
              if (
                connection &&
                typeof connection.sendRawTransaction === "function"
              ) {
                const sig = await connection.sendRawTransaction(raw, options);
                return sig;
              }
            } catch {}
            // Fallback to backend relay
            const txB64 = btoa(String.fromCharCode(...raw));
            const relay = await fetch(backendBase + "/solana/send-tx", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ txB64 }),
            });
            const j = await relay.json();
            if (!relay.ok) {
              throw new Error(j?.message || "relay failed");
            }
            return j.signature;
          },
        };
        const uploader = await builder.withProvider(walletShim);
        const bin = atob(dataB64);
        let body = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) body[i] = bin.charCodeAt(i);

        if (isPrivate) {
          add("Preparing encryption key from login signature...");
          const encSigB64 = (payload as any).encryptionSigB64 || "";
          if (!encSigB64) {
            add(
              'Not logged in. Run "permagit login" first to enable encryption.'
            );
            return;
          }
          let sig: Uint8Array;
          try {
            const bin = atob(encSigB64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            sig = arr;
          } catch {
            add("Invalid stored signature. Re-run permagit login.");
            return;
          }
          const digest = await crypto.subtle.digest("SHA-256", sig);
          const keyRaw = new Uint8Array(digest);
          const cryptoKey = await crypto.subtle.importKey(
            "raw",
            keyRaw,
            { name: "AES-GCM" },
            false,
            ["encrypt"]
          );
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encBuf = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            cryptoKey,
            body
          );
          const encArr = new Uint8Array(encBuf);
          const tag = encArr.slice(encArr.length - 16);
          const cipher = encArr.slice(0, encArr.length - 16);
          const combined = new Uint8Array(
            iv.length + tag.length + cipher.length
          );
          combined.set(iv, 0);
          combined.set(tag, iv.length);
          combined.set(cipher, iv.length + tag.length);
          body = combined;
          add("Encrypted bundle in browser.");
        }

        const price = await uploader.getPrice(body.length);
        const priceStr = (price as any)?.toString?.() || String(price ?? "0");
        add("Price (atomic): " + String(priceStr));

        // Prefer SDK fund() but proxy its RPC to backend; fallback to backend relay transfer
        let funded = false;
        try {
          setStep("fund");
          // Patch fetch to route Solana JSON-RPC through backend
          try {
            const backendRpc = backendBase + "/solana/rpc";
            const origFetch =
              (globalThis as any).fetch?.bind(globalThis) ||
              window.fetch.bind(window);
            const proxyFetch = async (input: any, init?: any) => {
              try {
                const url =
                  typeof input === "string"
                    ? input
                    : (input && (input as any).url) || "";
                const method = String(
                  (init && (init as any).method) ||
                    (input as any)?.method ||
                    "GET"
                ).toUpperCase();
                let bodyStr: string | null = null;
                if (init && typeof (init as any).body === "string") {
                  bodyStr = (init as any).body;
                } else if (
                  init &&
                  (init as any).body &&
                  typeof (init as any).body === "object"
                ) {
                  try {
                    const maybe = (init as any).body as any;
                    if (maybe && typeof maybe.jsonrpc !== "undefined") {
                      bodyStr = JSON.stringify(maybe);
                    } else if (typeof maybe.text === "function") {
                      bodyStr = await maybe.text();
                    } else if (maybe instanceof ArrayBuffer) {
                      bodyStr = new TextDecoder().decode(maybe);
                    } else if (ArrayBuffer.isView(maybe)) {
                      bodyStr = new TextDecoder().decode(maybe as any);
                    } else {
                      try {
                        bodyStr = JSON.stringify(maybe);
                      } catch {
                        bodyStr = null;
                      }
                    }
                  } catch {}
                } else if (
                  input &&
                  typeof (input as any).clone === "function"
                ) {
                  try {
                    const cloned = (input as any).clone();
                    bodyStr = await cloned.text();
                  } catch {}
                }
                const isSolanaUrl =
                  typeof url === "string" &&
                  /https?:\/\/.*(solana\.com|mainnet-beta|ankr\.com\/solana|alchemy|quicknode|helio|hivenet)/i.test(
                    url
                  );
                const looksRpc =
                  method === "POST" &&
                  !!bodyStr &&
                  (bodyStr.includes('"jsonrpc"') ||
                    bodyStr.includes("'jsonrpc'"));
                if (method === "POST" && (isSolanaUrl || looksRpc)) {
                  return origFetch(backendRpc, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: (bodyStr as string) || "",
                  });
                }
              } catch {}
              return origFetch(input, init);
            };
            (window as any).fetch = proxyFetch;
            (globalThis as any).fetch = proxyFetch;
            (self as any).fetch = proxyFetch;
          } catch {}

          // Check balance first if SDK supports it
          let needsFunding = true;
          try {
            const bal = await (uploader as any).getLoadedBalance?.();
            const balStr = bal?.toString?.() || String(bal ?? "0");
            if (balStr && /^[0-9]+$/.test(balStr)) {
              if (BigInt(balStr) >= BigInt(priceStr)) {
                add("Sufficient Irys balance detected. Skipping funding.");
                funded = true;
                needsFunding = false;
              }
            }
          } catch {}

          if (needsFunding) {
            add("Funding via SDK (proxied)...");
            try {
              const fundRes = await (uploader as any).fund?.(priceStr);
              add("Funded: " + JSON.stringify(fundRes ?? {}));
              funded = true;
            } catch (fundErr: any) {
              const msg =
                fundErr?.message ||
                fundErr?.toString?.() ||
                "unknown fund error";
              add("SDK fund error: " + msg);
              try {
                const resp = (fundErr as any)?.response;
                if (resp && typeof resp.text === "function") {
                  const t = await resp.text();
                  add("SDK fund response: " + t);
                }
              } catch {}
              // If user rejected fund, try proceeding with existing balance
              try {
                const bal2 = await (uploader as any).getLoadedBalance?.();
                const bal2Str = bal2?.toString?.() || String(bal2 ?? "0");
                if (bal2Str && /^[0-9]+$/.test(bal2Str)) {
                  if (BigInt(bal2Str) >= BigInt(priceStr)) {
                    add(
                      "Sufficient balance detected after fund rejection. Proceeding without funding."
                    );
                    funded = true;
                    // do not rethrow; continue to upload
                  } else {
                    throw fundErr;
                  }
                } else {
                  throw fundErr;
                }
              } catch {
                throw fundErr;
              }
            }
          }
        } catch (e: any) {
          add(
            "Funding error: SDK fund failed. Please check backend RPC (SOLANA_RPC_URL) and wallet balance."
          );
          return;
        }
        if (!funded) {
          add("Funding did not complete.");
          return;
        }

        setStep("upload");
        add("Uploading...");
        let uploadData: any = body;
        try {
          // Prefer Buffer to satisfy libraries that check Buffer.isBuffer
          uploadData = BufferPolyfill.from(body);
        } catch {
          // Fallback to Blob in browsers
          try {
            uploadData = new Blob([body], {
              type: "application/octet-stream",
            });
          } catch {}
        }
        const receipt = await uploader.upload(uploadData, { tags });
        const txId = receipt?.id || receipt?.id?.toString?.() || "";
        add("Upload done. TX: " + txId);
        setStep("done");
        await fetch("/done", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txId }),
        });
        // Close immediately so the terminal can finish without delay
        try {
          window.close();
        } catch {}
      } catch (e: any) {
        add("Error: " + (e?.message || String(e)));
        setStep("error");
      }
    })();
  }, []);

  return (
    <div className="gh-page">
      <header className="gh-header">
        <div className="gh-title">Push to Permagit</div>
        <div className="gh-sub">
          <span className="badge">
            {/* repo */}Repo:{" "}
            {(() => {
              try {
                const p: any = (window as any).__PERMAGIT__;
                const tags = p?.tags || [];
                const repo = Array.isArray(tags)
                  ? tags.find((t: any) => t.name === "Repo-Name")?.value || ""
                  : "";
                return repo || "unknown";
              } catch {
                return "unknown";
              }
            })()}
          </span>
          <span className="badge">
            {/* branch */}Branch:{" "}
            {(() => {
              try {
                const p: any = (window as any).__PERMAGIT__;
                const tags = p?.tags || [];
                const br = Array.isArray(tags)
                  ? tags.find((t: any) => t.name === "Branch")?.value || ""
                  : "";
                return br || "unknown";
              } catch {
                return "unknown";
              }
            })()}
          </span>
          <span className="badge badge-lock">
            {(() => {
              try {
                return (window as any).__PERMAGIT__?.isPrivate
                  ? "Private"
                  : "Public";
              } catch {
                return "Public";
              }
            })()}
          </span>
        </div>
      </header>

      <section className="gh-card">
        <div className="steps">
          <div
            className={`step ${
              step === "wallet" ? "active" : step !== "init" ? "done" : ""
            }`}
          >
            <span className="dot" /> Wallet
            {step === "wallet" ? (
              <span style={{ marginLeft: "auto" }} className="spinner" />
            ) : null}
          </div>
          <div
            className={`step ${
              step === "fund"
                ? "active"
                : step === "upload" || step === "done"
                ? "done"
                : ""
            }`}
          >
            <span className="dot" /> Fund
            {step === "fund" ? (
              <span style={{ marginLeft: "auto" }} className="spinner" />
            ) : null}
          </div>
          <div
            className={`step ${
              step === "upload" ? "active" : step === "done" ? "done" : ""
            }`}
          >
            <span className="dot" /> Upload
            {step === "upload" ? (
              <span style={{ marginLeft: "auto" }} className="spinner" />
            ) : null}
          </div>
          <div
            className={`step ${
              step === "done" ? "done" : step === "error" ? "error" : ""
            }`}
          >
            <span className="dot" /> Complete
            {step === "done" ? (
              <span style={{ marginLeft: "auto" }} className="spinner green" />
            ) : null}
          </div>
        </div>
        <pre className="gh-log">{log}</pre>
      </section>
    </div>
  );
};

const rootEl = document.getElementById("root")!;
createRoot(rootEl).render(<App />);
