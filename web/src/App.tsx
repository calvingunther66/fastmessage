import { AuthScreen } from "./components/AuthScreen.js";
import { CallOverlay } from "./components/CallOverlay.js";
import { ChatView } from "./components/ChatView.js";
import { Sidebar } from "./components/Sidebar.js";
import { useMessenger } from "./hooks.js";
import { messenger } from "./lib/messaging.js";

export function App() {
  const state = useMessenger();

  if (state.status === "loading") {
    return (
      <div className="splash">
        <div className="brand">
          <span className="brand-mark">🔒</span> FastMessage
        </div>
        <p>Unlocking your keys…</p>
      </div>
    );
  }

  if (state.status === "loggedOut") return <AuthScreen />;

  return (
    <div className="layout">
      <Sidebar />
      <ChatView />
      <CallOverlay />
      {state.recoveryKey && <RecoveryKeyModal value={state.recoveryKey} />}
    </div>
  );
}

function RecoveryKeyModal({ value }: { value: string }) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>🔑 Save your recovery key</h2>
        <p>
          If your account is ever locked after suspicious activity, you'll need
          this key <em>together with</em> the admin key to unlock it. It is shown
          only once and is never stored on the server.
        </p>
        <code className="recovery-key">{value}</code>
        <div className="modal-actions">
          <button
            className="primary"
            type="button"
            onClick={() => navigator.clipboard?.writeText(value).catch(() => undefined)}
          >
            Copy
          </button>
          <button
            className="tab"
            type="button"
            onClick={() => messenger.dismissRecoveryKey()}
          >
            I've saved it
          </button>
        </div>
      </div>
    </div>
  );
}
