// @ts-nocheck
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Buffer as BufferPolyfill } from "buffer";
import { WebUploader } from "@irys/web-upload";
import { WebSolana } from "@irys/web-upload-solana";

const App: React.FC = () => {
  const [log, setLog] = useState<string>("");
  const [step, setStep] = useState<
    "init" | "wallet" | "fund" | "done" | "error"
  >("init");
  const add = (m: string) => setLog((v) => v + (v ? "\n" : "") + m);

  useEffect(() => {
    (async () => {
      try {
        if (
          typeof window !== "undefined" &&
          (!window.Buffer || typeof window.Buffer.from !== "function")
        ) {
          // @ts-ignore
          window.Buffer = BufferPolyfill;
        }
        const payload = (window as any).__PERMAGIT__ || {};
        const backendBase = payload.backendBase || "";
        const defaultAmount = payload.amountSol || "";

        const provider = (window as any).solana;
        setStep("wallet");
        if (!provider || !provider.isPhantom) {
          add("Phantom wallet not detected.");
          setStep("error");
          return;
        }
        await provider.connect();
        add("Wallet connected: " + (provider.publicKey?.toBase58?.() || ""));

        add("Loading Irys Web SDK (local)...");
        let builder: any = WebUploader(WebSolana);
        // Ensure RPC proxy
        try {
          const rpcUrl = backendBase + "/solana/rpc";
          if (builder && typeof builder.withRpc === "function")
            builder = builder.withRpc(rpcUrl);
          else if (builder && typeof builder.withConfig === "function")
            builder = builder.withConfig({ rpcUrl });
        } catch {}
        const walletShim: any = {
          get publicKey() {
            return provider.publicKey;
          },
          signTransaction: (tx: any) => provider.signTransaction(tx),
          signAllTransactions: (txs: any[]) =>
            provider.signAllTransactions
              ? provider.signAllTransactions(txs)
              : Promise.all(txs.map((t) => provider.signTransaction(t))),
          signMessage: async (message: Uint8Array) => {
            if (typeof provider.signMessage === "function") {
              const res = await provider.signMessage(message, "utf8");
              return (res && (res.signature || res)) as Uint8Array;
            }
            throw new Error("signMessage not supported by wallet");
          },
          sendTransaction: async (tx: any, connection: any, options?: any) => {
            const signed = await provider.signTransaction(tx);
            const raw = signed.serialize();
            try {
              if (
                connection &&
                typeof connection.sendRawTransaction === "function"
              ) {
                return await connection.sendRawTransaction(raw, options);
              }
            } catch {}
            const txB64 = btoa(String.fromCharCode(...raw));
            const relay = await fetch(backendBase + "/solana/send-tx", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ txB64 }),
            });
            const j = await relay.json();
            if (!relay.ok) throw new Error(j?.message || "relay failed");
            return j.signature;
          },
        };
        const uploader = await builder.withProvider(walletShim);
        // Try to persist the bundler base URL for accurate status queries
        try {
          const candidates = [
            (uploader as any)?.url,
            (uploader as any)?.config?.url,
            (builder as any)?.url,
            (builder as any)?.config?.url,
          ].filter(Boolean);
          const u = String(candidates[0] || "");
          if (u && /^https?:\/\//i.test(u)) {
            await fetch("/bundler", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: u }),
            }).catch(() => {});
          }
        } catch {}

        // Show and remember balance if available
        let balanceBefore: string | null = null;
        try {
          const bal = await (uploader as any).getLoadedBalance?.();
          const b = bal?.toString?.() || String(bal);
          if (bal != null) {
            balanceBefore = b;
            add("Current Irys balance (atomic): " + b);
          }
        } catch {}

        setStep("fund");
        let amount = String(defaultAmount || "");
        if (!amount) {
          amount = prompt("Amount (SOL) to fund:", "0.1") || "";
        }
        if (!amount) {
          add("Fund canceled.");
          setStep("error");
          return;
        }
        const atomic = (uploader as any).utils?.toAtomic
          ? (uploader as any).utils.toAtomic(Number(amount))
          : Math.round(Number(amount) * 1e9);
        add(`Funding ${amount} SOL (atomic ${String(atomic)}) ...`);
        // Hook fetch to proxy RPC
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
              if (init && typeof (init as any).body === "string")
                bodyStr = (init as any).body;
              const looksRpc =
                method === "POST" &&
                !!bodyStr &&
                (bodyStr.includes('"jsonrpc"') ||
                  bodyStr.includes("'jsonrpc'"));
              if (looksRpc) {
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

        const res = await (uploader as any).fund?.(String(atomic));
        add("Fund result: " + JSON.stringify(res ?? {}));

        // Fetch updated balance (if available)
        let balanceAfter: string | null = null;
        try {
          const bal2 = await (uploader as any).getLoadedBalance?.();
          if (bal2 != null) balanceAfter = bal2?.toString?.() || String(bal2);
        } catch {}

        setStep("done");
        await fetch("/done", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amountSol: String(amount),
            amountAtomic: String(atomic),
            balanceBefore,
            balanceAfter,
            fundResult: res ?? null,
          }),
        }).catch(() => {});
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
        <div className="gh-title">Fund Irys</div>
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
              step === "fund" ? "active" : step === "done" ? "done" : ""
            }`}
          >
            <span className="dot" /> Fund
            {step === "fund" ? (
              <span style={{ marginLeft: "auto" }} className="spinner" />
            ) : null}
          </div>
          <div
            className={`step ${
              step === "done" ? "done" : step === "error" ? "error" : ""
            }`}
          >
            <span className="dot" /> Complete
          </div>
        </div>
        <pre className="gh-log">{log}</pre>
      </section>
    </div>
  );
};

const rootEl = document.getElementById("root")!;
createRoot(rootEl).render(<App />);
