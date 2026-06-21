import { type FormEvent, useEffect, useState } from "react";
import { useMessenger } from "../hooks.js";
import { messenger } from "../lib/messaging.js";

type Mode = "register" | "login" | "link";

export function AuthScreen() {
  const state = useMessenger();
  const [mode, setMode] = useState<Mode>("register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  // If opened via a device-link QR (…/?link=CODE), jump straight to linking.
  useEffect(() => {
    const link = new URLSearchParams(location.search).get("link");
    if (link) {
      setMode("link");
      setCode(link);
    }
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    messenger.clearError();
    setBusy(true);
    try {
      if (mode === "register") await messenger.register(username, password);
      else if (mode === "login") await messenger.login(username, password);
      else await messenger.linkWithCode(code);
    } catch {
      /* error surfaced via state */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark">🔒</span> FastMessage
        </div>
        <p className="tagline">End-to-end encrypted. Your server can't read it.</p>

        <div className="tabs">
          <button
            className={mode === "register" ? "tab active" : "tab"}
            onClick={() => setMode("register")}
            type="button"
          >
            Create
          </button>
          <button
            className={mode === "login" ? "tab active" : "tab"}
            onClick={() => setMode("login")}
            type="button"
          >
            Sign in
          </button>
          <button
            className={mode === "link" ? "tab active" : "tab"}
            onClick={() => setMode("link")}
            type="button"
          >
            Link device
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === "link" ? (
            <label>
              Link code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ABCD2345"
                autoCapitalize="characters"
                required
              />
            </label>
          ) : (
            <>
              <label>
                Username
                <input
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="alice"
                  required
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="at least 8 characters"
                  minLength={8}
                  required
                />
              </label>
            </>
          )}
          {state.error && <div className="error">{state.error}</div>}
          <button className="primary" type="submit" disabled={busy}>
            {busy
              ? "Working…"
              : mode === "register"
                ? "Create account"
                : mode === "login"
                  ? "Sign in"
                  : "Link this device"}
          </button>
        </form>

        <p className="fineprint">
          {mode === "register"
            ? "A device key is generated locally and never leaves this browser."
            : mode === "login"
              ? "Signing in registers this browser as a new device."
              : "Enter a code from an already signed-in device — no password needed."}
        </p>
      </div>
    </div>
  );
}
