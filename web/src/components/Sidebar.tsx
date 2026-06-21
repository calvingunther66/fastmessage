import { type FormEvent, useState } from "react";
import { useMessenger } from "../hooks.js";
import { messenger } from "../lib/messaging.js";

export function Sidebar() {
  const state = useMessenger();
  const [newChat, setNewChat] = useState("");
  const [showGroup, setShowGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState("");

  const conversations = Object.values(state.conversations).sort((a, b) => {
    const la = a.messages.at(-1)?.sentAt ?? 0;
    const lb = b.messages.at(-1)?.sentAt ?? 0;
    return lb - la;
  });

  const startChat = async (e: FormEvent) => {
    e.preventDefault();
    const name = newChat.trim();
    if (!name) return;
    if (await messenger.startConversation(name)) setNewChat("");
  };

  const createGroup = async (e: FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) return;
    await messenger.createGroup(
      groupName.trim(),
      groupMembers.split(",").map((s) => s.trim()).filter(Boolean),
    );
    setGroupName("");
    setGroupMembers("");
    setShowGroup(false);
  };

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <div className="me">
          <strong>{state.identity?.username}</strong>
          <span className={state.connected ? "dot online" : "dot offline"}>
            {state.connected ? "online" : "connecting…"}
          </span>
        </div>
        <button className="link" onClick={() => void messenger.logout()} type="button">
          Sign out
        </button>
      </header>

      <form className="new-chat" onSubmit={startChat}>
        <input
          value={newChat}
          onChange={(e) => setNewChat(e.target.value)}
          placeholder="Start chat with username…"
          autoCapitalize="none"
        />
        <button type="submit" title="Start direct chat">
          +
        </button>
      </form>

      <div className="new-group-toggle">
        <button className="link" type="button" onClick={() => setShowGroup((v) => !v)}>
          {showGroup ? "Cancel" : "+ New group"}
        </button>
      </div>
      {showGroup && (
        <form className="new-group" onSubmit={createGroup}>
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Group name"
          />
          <input
            value={groupMembers}
            onChange={(e) => setGroupMembers(e.target.value)}
            placeholder="members: alice, bob"
            autoCapitalize="none"
          />
          <button type="submit">Create group</button>
        </form>
      )}

      <nav className="conversations">
        {conversations.length === 0 && (
          <p className="empty">No conversations yet.</p>
        )}
        {conversations.map((c) => {
          const last = c.messages.at(-1);
          return (
            <button
              key={c.id}
              className={
                state.activeConvId === c.id ? "conversation active" : "conversation"
              }
              onClick={() => messenger.setActiveConv(c.id)}
              type="button"
            >
              <span className="conv-name">
                {c.kind === "group" ? "👥 " : ""}
                {c.title}
              </span>
              <span className="conv-preview">
                {last ? `${last.dir === "out" ? "You: " : ""}${last.body}` : "…"}
              </span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
