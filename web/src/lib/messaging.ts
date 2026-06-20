import {
  CryptoAccount,
  CryptoSession,
  randomPickleKey,
  type IdentityKeys,
} from "@fastmessage/crypto";
import {
  type EncryptedEnvelope,
  type MessageContent,
  type ServerFrame,
  WS_PATH,
} from "@fastmessage/shared";
import { api, ApiError } from "./api.js";
import { ensureCrypto } from "./crypto-init.js";
import {
  storage,
  type StoredConversation,
  type StoredMessageRec,
} from "./db.js";

const INITIAL_ONE_TIME_KEYS = 20;
const REPLENISH_BATCH = 5;

export interface Identity {
  token: string;
  userId: string;
  deviceId: string;
  username: string;
  expiresAt: number;
}

export interface ChatMessage {
  id: string;
  convId: string;
  dir: "in" | "out";
  body: string;
  sentAt: number;
  status?: "sending" | "sent" | "failed";
}

export interface Conversation {
  peerUserId: string;
  username: string;
  messages: ChatMessage[];
}

export interface MessengerState {
  status: "loading" | "loggedOut" | "ready";
  connected: boolean;
  identity?: Identity;
  conversations: Record<string, Conversation>;
  activePeer?: string;
  error?: string;
}

type Listener = () => void;

class Messenger {
  private state: MessengerState = {
    status: "loading",
    connected: false,
    conversations: {},
  };
  private listeners = new Set<Listener>();

  private account: CryptoAccount | null = null;
  private pickleKey = "";
  private sessions = new Map<string, CryptoSession[]>();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;

  // ---- external store API (for React's useSyncExternalStore) -------------
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): MessengerState => this.state;

  private set(patch: Partial<MessengerState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private upsertConversation(conv: Conversation) {
    this.set({
      conversations: { ...this.state.conversations, [conv.peerUserId]: conv },
    });
  }

  // ---- boot --------------------------------------------------------------
  async boot(): Promise<void> {
    await ensureCrypto();
    const identity = await storage.getKV<Identity>("identity");
    const pickleKey = await storage.getKV<string>("pickleKey");
    const accountPickle = await storage.getKV<string>("accountPickle");

    if (identity && pickleKey && accountPickle && identity.expiresAt > Date.now()) {
      this.pickleKey = pickleKey;
      this.account = CryptoAccount.unpickle(pickleKey, accountPickle);
      await this.loadSessions();
      await this.loadConversations();
      this.set({ status: "ready", identity });
      this.connect();
    } else {
      this.set({ status: "loggedOut" });
    }
  }

  private async loadSessions() {
    this.sessions.clear();
    for (const rec of await storage.allSessions()) {
      this.sessions.set(
        rec.identityKey,
        rec.pickles.map((p) => CryptoSession.unpickle(this.pickleKey, p)),
      );
    }
  }

  private async loadConversations() {
    const convs = await storage.allConversations();
    const map: Record<string, Conversation> = {};
    for (const c of convs) {
      const msgs = (await storage.messagesFor(c.peerUserId)).sort(
        (a, b) => a.sentAt - b.sentAt,
      );
      map[c.peerUserId] = {
        peerUserId: c.peerUserId,
        username: c.username,
        messages: msgs,
      };
    }
    this.set({ conversations: map });
  }

  // ---- auth --------------------------------------------------------------
  async register(username: string, password: string): Promise<void> {
    await this.authenticate("register", username, password);
  }
  async login(username: string, password: string): Promise<void> {
    await this.authenticate("login", username, password);
  }

  private async authenticate(
    mode: "register" | "login",
    username: string,
    password: string,
  ): Promise<void> {
    await ensureCrypto();
    this.set({ error: undefined });
    try {
      const account = CryptoAccount.create();
      const keys: IdentityKeys = account.identityKeys();
      const oneTimeKeys = account.generateOneTimeKeys(INITIAL_ONE_TIME_KEYS);
      const fallbackKey = account.generateFallbackKey();
      const deviceId = crypto.randomUUID();

      const device = {
        deviceId,
        displayName: username,
        identityKey: keys.curve25519,
        signingKey: keys.ed25519,
        oneTimeKeys,
        fallbackKey,
      };
      const auth =
        mode === "register"
          ? await api.register({ username, password, device })
          : await api.login({ username, password, device });
      account.markKeysAsPublished();

      this.account = account;
      this.pickleKey = randomPickleKey();
      const identity: Identity = {
        token: auth.token,
        userId: auth.userId,
        deviceId: auth.deviceId,
        username: auth.username,
        expiresAt: auth.expiresAt,
      };
      await storage.setKV("identity", identity);
      await storage.setKV("pickleKey", this.pickleKey);
      await this.saveAccount();

      this.set({ status: "ready", identity, conversations: {} });
      this.connect();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Something went wrong";
      this.set({ error: message });
      throw err;
    }
  }

  async logout(): Promise<void> {
    const id = this.state.identity;
    this.socket?.close();
    this.socket = null;
    if (id) await api.logout(id.token).catch(() => undefined);
    await storage.clearAll();
    this.account?.free();
    this.account = null;
    this.sessions.clear();
    this.set({ status: "loggedOut", identity: undefined, conversations: {}, activePeer: undefined });
  }

  // ---- persistence helpers ----------------------------------------------
  private async saveAccount() {
    if (!this.account) return;
    await storage.setKV("accountPickle", this.account.pickle(this.pickleKey));
  }
  private async saveSessions(identityKey: string) {
    const list = this.sessions.get(identityKey) ?? [];
    await storage.putSessions({
      identityKey,
      pickles: list.map((s) => s.pickle(this.pickleKey)),
    });
  }

  private async replenishKeys(count: number) {
    if (!this.account || !this.state.identity) return;
    const oneTimeKeys = this.account.generateOneTimeKeys(count);
    this.account.markKeysAsPublished();
    await api
      .replenish({ oneTimeKeys }, this.state.identity.token)
      .catch(() => undefined);
    await this.saveAccount();
  }

  // ---- WebSocket ---------------------------------------------------------
  private connect() {
    const id = this.state.identity;
    if (!id) return;
    const url = `${location.origin.replace(/^http/, "ws")}${WS_PATH}?token=${id.token}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelay = 1000;
      this.set({ connected: true });
    };
    socket.onclose = () => {
      this.set({ connected: false });
      this.scheduleReconnect();
    };
    socket.onerror = () => socket.close();
    socket.onmessage = (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      void this.onServerFrame(frame);
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.state.status !== "ready") return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  private sendFrame(frame: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  private async onServerFrame(frame: ServerFrame) {
    switch (frame.t) {
      case "ready":
        this.set({ connected: true });
        break;
      case "message":
        await this.handleIncoming(frame.message);
        break;
      case "error":
        console.warn("server error frame", frame);
        break;
      default:
        break;
    }
  }

  // ---- sending -----------------------------------------------------------
  async startConversation(username: string): Promise<string | undefined> {
    const id = this.state.identity;
    if (!id) return undefined;
    try {
      const { userId } = await api.lookup(username, id.token);
      const existing = this.state.conversations[userId];
      const conv: Conversation = existing ?? {
        peerUserId: userId,
        username,
        messages: [],
      };
      await storage.putConversation({ peerUserId: userId, username });
      this.upsertConversation(conv);
      this.set({ activePeer: userId });
      return userId;
    } catch (err) {
      this.set({ error: err instanceof ApiError ? err.message : "Lookup failed" });
      return undefined;
    }
  }

  setActivePeer(peerUserId: string) {
    this.set({ activePeer: peerUserId });
  }

  private async ensureOutboundSession(target: {
    userId: string;
    deviceId: string;
  }): Promise<CryptoSession> {
    const id = this.state.identity!;
    const bundle = (await api.claim([target], id.token)).bundles[0];
    if (!bundle?.oneTimeKey) {
      throw new Error("Recipient has no available keys");
    }
    const existing = this.sessions.get(bundle.identityKey);
    if (existing && existing.length > 0) return existing[existing.length - 1]!;

    const session = this.account!.createOutboundSession(
      bundle.identityKey,
      bundle.oneTimeKey.key,
    );
    this.sessions.set(bundle.identityKey, [...(existing ?? []), session]);
    await this.saveSessions(bundle.identityKey);
    return session;
  }

  async sendText(peerUserId: string, text: string): Promise<void> {
    const id = this.state.identity;
    if (!id || !this.account || !text.trim()) return;

    const msgId = crypto.randomUUID();
    const content: MessageContent = {
      kind: "text",
      body: text,
      sentAt: Date.now(),
      msgId,
    };

    // Optimistically render the outgoing message.
    const conv = this.state.conversations[peerUserId];
    const username = conv?.username ?? peerUserId;
    const record: StoredMessageRec = {
      id: msgId,
      convId: peerUserId,
      dir: "out",
      body: text,
      sentAt: content.sentAt,
      status: "sending",
    };
    await storage.putMessage(record);
    this.appendMessage(peerUserId, username, record);

    try {
      const { devices } = await api.devices(peerUserId, id.token);
      if (devices.length === 0) throw new Error("Recipient has no devices");

      for (const device of devices) {
        const session = await this.ensureOutboundSession({
          userId: peerUserId,
          deviceId: device.deviceId,
        });
        const enc = session.encrypt(JSON.stringify(content));
        await this.saveSessions(device.identityKey);
        const envelope: EncryptedEnvelope = {
          v: 1,
          alg: "olm",
          msgType: enc.msgType,
          body: enc.body,
          senderIdentityKey: this.account.identityKeys().curve25519,
        };
        this.sendFrame({
          t: "send",
          message: {
            toUserId: peerUserId,
            toDeviceId: device.deviceId,
            clientMsgId: `${msgId}:${device.deviceId}`,
            envelope,
          },
        });
      }
      await this.updateMessageStatus(peerUserId, msgId, "sent");
    } catch (err) {
      await this.updateMessageStatus(peerUserId, msgId, "failed");
      this.set({ error: err instanceof Error ? err.message : "Send failed" });
    }
  }

  // ---- receiving ---------------------------------------------------------
  private async handleIncoming(message: {
    id: string;
    fromUserId: string;
    fromDeviceId: string;
    envelope: EncryptedEnvelope;
    sentAt: number;
  }): Promise<void> {
    try {
      const plaintext = await this.decryptEnvelope(message.envelope);
      const content = JSON.parse(plaintext) as MessageContent;
      this.sendFrame({ t: "ack", ids: [message.id] });

      if (content.kind !== "text") return; // groups/attachments/etc. come later

      const convId = message.fromUserId;
      let username = this.state.conversations[convId]?.username;
      if (!username) {
        username = await this.resolveUsername(convId);
        await storage.putConversation({ peerUserId: convId, username });
      }
      const record: StoredMessageRec = {
        id: content.msgId || message.id,
        convId,
        dir: "in",
        body: content.body,
        sentAt: content.sentAt || message.sentAt,
      };
      await storage.putMessage(record);
      this.appendMessage(convId, username, record);
    } catch (err) {
      console.warn("failed to handle incoming message", err);
      // Still ack so the server can drop an undecryptable duplicate.
      this.sendFrame({ t: "ack", ids: [message.id] });
    }
  }

  private async decryptEnvelope(env: EncryptedEnvelope): Promise<string> {
    if (env.alg !== "olm") throw new Error(`unsupported alg ${env.alg}`);
    const ik = env.senderIdentityKey;
    const list = this.sessions.get(ik) ?? [];

    if (env.msgType === 0) {
      for (const s of list) {
        if (s.matchesInbound(env.body)) {
          const pt = s.decrypt(0, env.body);
          await this.saveSessions(ik);
          return pt;
        }
      }
      const { session, plaintext } = this.account!.createInboundSession(
        ik,
        env.body,
      );
      this.sessions.set(ik, [...list, session]);
      await this.saveSessions(ik);
      await this.saveAccount();
      await this.replenishKeys(REPLENISH_BATCH);
      return plaintext;
    }

    for (const s of list) {
      try {
        const pt = s.decrypt(1, env.body);
        await this.saveSessions(ik);
        return pt;
      } catch {
        /* try the next session */
      }
    }
    throw new Error("no matching session for message");
  }

  private async resolveUsername(userId: string): Promise<string> {
    const id = this.state.identity!;
    try {
      return (await api.profile(userId, id.token)).username;
    } catch {
      return userId.slice(0, 8);
    }
  }

  // ---- conversation state mutation --------------------------------------
  private appendMessage(
    peerUserId: string,
    username: string,
    record: StoredMessageRec,
  ) {
    const existing = this.state.conversations[peerUserId];
    const messages = existing ? existing.messages.slice() : [];
    if (!messages.some((m) => m.id === record.id)) messages.push(record);
    messages.sort((a, b) => a.sentAt - b.sentAt);
    this.upsertConversation({ peerUserId, username, messages });
  }

  private async updateMessageStatus(
    peerUserId: string,
    msgId: string,
    status: ChatMessage["status"],
  ) {
    const conv = this.state.conversations[peerUserId];
    if (!conv) return;
    const messages = conv.messages.map((m) =>
      m.id === msgId ? { ...m, status } : m,
    );
    const updated = messages.find((m) => m.id === msgId);
    if (updated) await storage.putMessage(updated as StoredMessageRec);
    this.upsertConversation({ ...conv, messages });
  }

  fingerprint(): string {
    return this.account ? this.account.identityKeys().ed25519 : "";
  }

  clearError() {
    if (this.state.error) this.set({ error: undefined });
  }
}

export const messenger = new Messenger();
export type { StoredConversation };
