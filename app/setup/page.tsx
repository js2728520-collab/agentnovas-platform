"use client";

import { FormEvent, useState } from "react";

export default function SetupPage() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("Creating company super administrator…");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/system/bootstrap", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-key": String(form.get("bootstrapKey") || ""),
        },
        body: JSON.stringify({
          email: String(form.get("email") || ""),
          password: String(form.get("password") || ""),
        }),
      });
      const data = (await response.json()) as { message?: string; error?: string };
      setMessage(data.message || data.error || "Operation completed");
      if (response.ok) {
        event.currentTarget.reset();
        window.setTimeout(() => { window.location.href = "/"; }, 1800);
      }
    } catch {
      setMessage("Cannot connect to the server. Please make sure it is running.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 560, margin: "80px auto", padding: 24 }}>
      <section className="wide-panel">
        <p className="eyebrow">AGENTNOVAS ADMIN</p>
        <h1>Initialize company super administrator</h1>
        <p>Use this page during local development to reset the administrator password; online environments only allow first-time initialization.</p>
        <form onSubmit={submit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
          <label>Administrator email<input name="email" type="email" required placeholder="Enter administrator email" autoComplete="email" /></label>
          <label>Administrator password<input name="password" type="password" minLength={10} required placeholder="At least 10 characters" /></label>
          <label>Bootstrap key<input name="bootstrapKey" type="password" required placeholder="Enter the configured bootstrap key" /></label>
          <button className="primary" disabled={busy}>{busy ? "Processing…" : "Create super administrator"}</button>
        </form>
        {message && <p className="admin-notice" style={{ marginTop: 16 }}>{message}</p>}
      </section>
    </main>
  );
}
