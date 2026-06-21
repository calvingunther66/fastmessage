import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { useMessenger } from "../hooks.js";
import { calls } from "../lib/calls.js";
import { messenger } from "../lib/messaging.js";
import { Attachment } from "./Attachment.js";

export function ChatView() {
  const state = useMessenger();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const conv = state.activeConvId
    ? state.conversations[state.activeConvId]
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
    await messenger.sendText(conv.id, text);
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await messenger.sendAttachment(conv.id, file);
  };

  const subtitle =
    conv.kind === "group"
      ? `${conv.members?.length ?? "?"} members · 🔒 encrypted`
      : "🔒 encrypted";

  return (
    <main className="chat">
      <header className="chat-head">
        <div className="chat-title">
          <strong>
            {conv.kind === "group" ? "👥 " : ""}
            {conv.title}
          </strong>
          <span className="chat-sub">{subtitle}</span>
        </div>
        {conv.kind === "dm" && (
          <div className="call-buttons">
            <button
              type="button"
              title="Voice call"
              onClick={() => void calls.startCall(conv.id, false)}
            >
              📞
            </button>
            <button
              type="button"
              title="Video call"
              onClick={() => void calls.startCall(conv.id, true)}
            >
              🎥
            </button>
          </div>
        )}
      </header>

      <div className="messages">
        {conv.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.dir}`}>
            {m.dir === "in" && conv.kind === "group" && m.sender && (
              <div className="bubble-sender">{m.sender}</div>
            )}
            <div className="bubble-body">
              {m.attachment ? <Attachment meta={m.attachment} /> : m.body}
            </div>
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
        <label className="attach-btn" title="Attach a file">
          📎
          <input type="file" hidden onChange={onFile} />
        </label>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message ${conv.title}…`}
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
