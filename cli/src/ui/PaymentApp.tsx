// @ts-nocheck
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Buffer as BufferPolyfill } from "buffer";

declare global {
  interface Window {
    solana?: any;
    solanaWeb3?: any;
    __PERMAGIT__?: {
      txB64: string;
      owner: string;
      destination: string;
      mint: string;
      amountAtomic: string;
    };
  }
}

const App: React.FC = () => {
  const [log, setLog] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const add = (msg: string) => setLog((prev) => (prev ? `${prev}\n${msg}` : msg));

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
        const payload = window.__PERMAGIT__;
        if (!payload || !payload.txB64) {
          add("Missing payment payload.");
          return;
        }
        const provider = window.solana;
        if (!provider || !provider.isPhantom) {
          add("Phantom wallet not detected.");
          return;
        }
        setBusy(true);
        await provider.connect();
        const walletPk = provider.publicKey?.toBase58?.();
        add(`Wallet connected: ${walletPk || "unknown"}`);
        if (payload.owner && walletPk && walletPk !== payload.owner) {
          add("Warning: Connected wallet does not match payer requested by CLI.");
        }
        if (!window.solanaWeb3) {
          add("window.solanaWeb3 missing.");
          return;
        }
        const raw = Uint8Array.from(atob(payload.txB64), (c) =>
          c.charCodeAt(0)
        );
        const tx = window.solanaWeb3.VersionedTransaction.deserialize(raw);
        add("Signing payment transaction...");
        const result = await provider.signAndSendTransaction(tx);
        const signature =
          (result && (result.signature || result)) || "";
        add("Payment submitted. Signature: " + signature);
        await fetch("/signature", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signature }),
        });
        await fetch("/done", { method: "POST" });
        try {
          window.close();
        } catch {}
      } catch (err: any) {
        add("Error: " + (err?.message || String(err)));
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  const payload = window.__PERMAGIT__;
  return (
    <div className="page">
      <div className="card">
        <h2>Approve Payment</h2>
        <p>
          Mint: <code>{payload?.mint || "unknown"}</code>
        </p>
        <p>
          Destination: <code>{payload?.destination || "unknown"}</code>
        </p>
        <p>
          Amount (atomic): <code>{payload?.amountAtomic || "0"}</code>
        </p>
        <button disabled>{busy ? "Waiting for wallet..." : "Done"}</button>
        <pre>{log}</pre>
      </div>
    </div>
  );
};

const rootEl = document.getElementById("root")!;
createRoot(rootEl).render(<App />);

