"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

export default function LoginForm({ configured }: { configured: boolean }) {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(configured ? "" : "Owner authentication is not configured. Check the server environment and readiness probe.");
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!configured) return;
    void fetch("/api/auth/csrf", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { csrfToken?: unknown; message?: unknown };
        if (!response.ok || typeof payload.csrfToken !== "string") throw new Error(typeof payload.message === "string" ? payload.message : "Secure login token could not be created");
        setCsrfToken(payload.csrfToken);
        passwordRef.current?.focus();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Secure login token could not be created"));
  }, [configured]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!csrfToken) return;
    const passwordBytes = new TextEncoder().encode(password).byteLength;
    if (passwordBytes < 16 || passwordBytes > 1_024) {
      setError("Owner password must contain 16–1024 UTF-8 bytes.");
      passwordRef.current?.focus();
      return;
    }
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ProofCanvas-CSRF": csrfToken },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json() as { message?: unknown };
      if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "Login failed");
      window.location.assign("/");
    } catch (reason) {
      setPassword("");
      setError(reason instanceof Error ? reason.message : "Login failed");
      passwordRef.current?.focus();
    } finally {
      setPending(false);
    }
  };

  return <main className="pc-login-shell">
    <section className="pc-login-card" aria-labelledby="login-title">
      <div className="pc-login-mark" aria-hidden="true">∴</div>
      <p className="pc-eyebrow">Private single-owner studio</p>
      <h1 id="login-title">Enter ProofCanvas</h1>
      <p>Your projects, checkpoints, AI proxy, and renderer stay behind this owner session.</p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="owner-password">Owner password</label>
        <input ref={passwordRef} id="owner-password" name="password" type="password" autoComplete="current-password" aria-describedby="owner-password-policy" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={1_024} required disabled={!configured || pending} />
        <small id="owner-password-policy" className="pc-login-policy">At least 16 UTF-8 bytes.</small>
        <button type="submit" disabled={!configured || !csrfToken || pending}>{pending ? "Checking…" : "Log in"}</button>
      </form>
      {error && <p className="pc-login-error" role="alert">{error}</p>}
    </section>
  </main>;
}
