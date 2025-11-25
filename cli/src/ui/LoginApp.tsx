// @ts-nocheck
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const App: React.FC = () => {
  const [log, setLog] = useState<string>("");
  const [step, setStep] = useState<
    "init" | "wallet" | "sign" | "save" | "done" | "error"
  >("init");
  const add = (m: string) => setLog((v) => v + (v ? "\n" : "") + m);

  const connectAndSign = async () => {
    try {
      setStep("wallet");
      const provider = (window as any).solana;
      if (!provider || !provider.isPhantom) {
        add("Phantom wallet not detected.");
        setStep("error");
        return;
      }
      await provider.connect();
      const publicKey = provider.publicKey?.toBase58?.() || "";
      if (!publicKey) {
        add("Wallet connect failed: no publicKey");
        setStep("error");
        return;
      }
      add("Connected: " + publicKey);

      setStep("sign");
      const msg = "Permagit Repo Encryption v1";
      if (!provider.signMessage) {
        add("signMessage not supported by this wallet.");
        setStep("error");
        return;
      }
      const enc = new TextEncoder().encode(msg);
      const { signature } = await provider.signMessage(enc, "utf8");
      const sigArr = (signature || new Uint8Array()) as Uint8Array;
      const sigB64 = btoa(String.fromCharCode(...sigArr));
      add("Message signed.");

      setStep("save");
      const res = await fetch("/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey, signature: sigB64 }),
      });
      if (!res.ok) {
        const t = await res.text();
        add("Save failed: " + t);
        setStep("error");
        return;
      }
      add("Saved to CLI config.");
      setStep("done");
      try {
        await fetch("/done", { method: "POST" });
      } catch {}
      try {
        window.close();
      } catch {}
    } catch (e: any) {
      add("Error: " + (e?.message || String(e)));
      setStep("error");
    }
  };

  useEffect(() => {
    // Auto-start for snappier UX
    connectAndSign();
  }, []);

  return (
    <div className="gh-page">
      <header className="gh-header">
        <div className="gh-title">Login to Permagit</div>
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
              step === "sign"
                ? "active"
                : step === "save" || step === "done"
                ? "done"
                : ""
            }`}
          >
            <span className="dot" /> Sign
            {step === "sign" ? (
              <span style={{ marginLeft: "auto" }} className="spinner" />
            ) : null}
          </div>
          <div
            className={`step ${
              step === "save" ? "active" : step === "done" ? "done" : ""
            }`}
          >
            <span className="dot" /> Save
            {step === "save" ? (
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
              <span style={{ marginLeft: "auto" }} className="spinner" />
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
