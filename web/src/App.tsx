import { AuthScreen } from "./components/AuthScreen.js";
import { ChatView } from "./components/ChatView.js";
import { Sidebar } from "./components/Sidebar.js";
import { useMessenger } from "./hooks.js";

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
    </div>
  );
}
