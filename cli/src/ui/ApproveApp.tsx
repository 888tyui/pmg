// @ts-nocheck
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Buffer as BufferPolyfill } from "buffer";

declare global {
  interface Window {
    solana?: any;
    __PERMAGIT__?: {
      txId: string;
      repoName?: string | null;
      owner?: string | null;
    };
  }
}

const App: React.FC = () => {
  const [log, setLog] = useState<string>("Connecting to wallet...");
  const [loading, setLoading] = useState<boolean>(true);

  const append = (message: string) =>
    setLog((prev) => (prev ? `${prev}\n${message}` : message));

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
        if (!payload || !payload.txId) {
          append("Missing approval payload.");
          setLoading(false);
          return;
        }
        const provider = window.solana;
        if (!provider || !provider.isPhantom) {
          append("Phantom wallet not detected.");
          setLoading(false);
          return;
        }
        await provider.connect();
        const publicKey = provider.publicKey?.toBase58?.();
        append(`Wallet connected: ${publicKey || "unknown"}`);
        const message = `Permagit Push Approval:${payload.txId}`;
        append(`Signing message for tx ${payload.txId} ...`);
        const encoder = new TextEncoder();
        const encoded = encoder.encode(message);
        const signatureRes = await provider.signMessage(encoded, "utf8");
        const signature =
          signatureRes?.signature || signatureRes || new Uint8Array();
        const signatureB64 = Buffer.from(signature).toString("base64");
        await fetch("/callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            publicKey,
            signature: signatureB64,
          }),
        });
        append("Signature captured. You can close this tab.");
        setLoading(false);
        await fetch("/done", { method: "POST" });
        try {
          window.close();
        } catch {}
      } catch (err: any) {
        append(`Error: ${err?.message || String(err)}`);
        setLoading(false);
      }
    })();
  }, []);

  const payload = window.__PERMAGIT__;
  return (
    <div className="page">
      <div className="card">
        <h2>Approve Permagit Push</h2>
        <p>
          Repo: <strong>{payload?.repoName || "unknown"}</strong>
        </p>
        <p>
          Tx: <code>{payload?.txId || "unknown"}</code>
        </p>
        <button disabled>{loading ? "Waiting for wallet..." : "Done"}</button>
        <pre className="log">{log}</pre>
      </div>
    </div>
  );
};

const rootEl = document.getElementById("root")!;
createRoot(rootEl).render(<App />);

