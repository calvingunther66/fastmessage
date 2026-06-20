import { type FormEvent, useEffect, useRef, useState } from "react";
import { useMessenger } from "../hooks.js";
import { messenger } from "../lib/messaging.js";

export function ChatView() {
  const state = useMessenger();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const conv = state.activePeer
    ? state.conversations[state.activePeer]
    : undefined;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conv?.messages.length]);

  if (!conv) {
    return (
      <main className="chat empty-chat">
        <div>
          <h2>Select or start a conversation</h2>
          <p>Messages are end-to-end encrypted with the Double Ratchet.</p>
        </div>
      </main>
    );
  }

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft;
    setDraft("");
    await messenger.sendText(conv.peerUserId, text);
  };

  return (
    <main className="chat">
      <header className="chat-head">
        <strong>{conv.username}</strong>
        <span className="lock" title="End-to-end encrypted">
          🔒 encrypted
        </span>
      </header>

      <div className="messages">
        {conv.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.dir}`}>
            <div className="bubble-body">{m.body}</div>
            <div className="bubble-meta">
              {new Date(m.sentAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
              {m.dir === "out" && m.status === "failed" && " · failed"}
              {m.dir === "out" && m.status === "sending" && " · …"}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={send}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message ${conv.username}…`}
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
