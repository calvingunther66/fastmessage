import { type FormEvent, useState } from "react";
import { useMessenger } from "../hooks.js";
import { messenger } from "../lib/messaging.js";

export function AuthScreen() {
  const state = useMessenger();
  const [mode, setMode] = useState<"register" | "login">("register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    messenger.clearError();
    setBusy(true);
    try {
      if (mode === "register") await messenger.register(username, password);
      else await messenger.login(username, password);
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
            Create account
          </button>
          <button
            className={mode === "login" ? "tab active" : "tab"}
            onClick={() => setMode("login")}
            type="button"
          >
            Sign in
          </button>
        </div>

        <form onSubmit={submit}>
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
          {state.error && <div className="error">{state.error}</div>}
          <button className="primary" type="submit" disabled={busy}>
            {busy
              ? "Working…"
              : mode === "register"
                ? "Create account"
                : "Sign in"}
          </button>
        </form>

        <p className="fineprint">
          {mode === "register"
            ? "A device key is generated locally and never leaves this browser."
            : "Signing in registers this browser as a new device."}
        </p>
      </div>
    </div>
  );
}
