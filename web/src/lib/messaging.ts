import {
  CryptoAccount,
  CryptoSession,
  GroupInboundSession,
  GroupSession,
  randomPickleKey,
  type IdentityKeys,
} from "@fastmessage/crypto";
import {
  type EncryptedEnvelope,
  type GroupInfo,
  type GroupMember,
  type MegolmEnvelope,
  type MessageContent,
  type ServerFrame,
  type StoredMessage,
  WS_PATH,
} from "@fastmessage/shared";
import { api, ApiError } from "./api.js";
import { ensureCrypto } from "./crypto-init.js";
import { storage, type StoredMessageRec } from "./db.js";
import { decryptToBlob, encryptFile, type AttachmentMeta } from "./files.js";

const INITIAL_ONE_TIME_KEYS = 20;
const REPLENISH_BATCH = 5;

export interface Identity {
  token: string;
  userId: string;
  deviceId: string;
  username: string;
  expiresAt: number;
}

export type ConversationKind = "dm" | "group";

export interface ChatMessage {
  id: string;
  convId: string;
  dir: "in" | "out";
  body: string;
  sentAt: number;
  sender?: string; // display name of the sender (group messages)
  attachment?: AttachmentMeta;
  status?: "sending" | "sent" | "failed";
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string;
  messages: ChatMessage[];
  members?: GroupMember[];
}

export interface MessengerState {
  status: "loading" | "loggedOut" | "ready";
  connected: boolean;
  identity?: Identity;
  conversations: Record<string, Conversation>;
  activeConvId?: string;
  error?: string;
  /** Shown once right after registration so the user can save it. */
  recoveryKey?: string;
}

type Listener = () => void;

interface OutboundGroup {
  session: GroupSession;
  sessionId: string;
  deliveredTo: Set<string>;
  memberSig: string;
}

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
  private groupOut = new Map<string, OutboundGroup>();
  private groupIn = new Map<string, GroupInboundSession>();
  private pendingGroup = new Map<string, StoredMessage[]>();
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

  private get id(): Identity {
    return this.state.identity!;
  }
  private get myIdentityKey(): string {
    return this.account!.identityKeys().curve25519;
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
      await this.loadGroupInSessions();
      await this.loadConversations();
      this.set({ status: "ready", identity });
      this.connect();
      void this.refreshGroups();
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

  private async loadGroupInSessions() {
    this.groupIn.clear();
    for (const rec of await storage.allGroupIn()) {
      this.groupIn.set(
        rec.sessionId,
        GroupInboundSession.unpickle(this.pickleKey, rec.pickle),
      );
    }
  }

  private async loadConversations() {
    const convs = await storage.allConversations();
    const map: Record<string, Conversation> = {};
    for (const c of convs) {
      const msgs = (await storage.messagesFor(c.id)).sort(
        (a, b) => a.sentAt - b.sentAt,
      );
      map[c.id] = { id: c.id, kind: c.kind, title: c.title, messages: msgs };
    }
    this.set({ conversations: map });
  }

  /** Pull the server's view of our groups and reflect membership changes. */
  private async refreshGroups() {
    try {
      const { groups } = await api.listGroups(this.id.token);
      for (const g of groups) await this.ensureGroupConversation(g);
    } catch {
      /* offline; we'll retry on next boot */
    }
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

      this.set({
        status: "ready",
        identity,
        conversations: {},
        recoveryKey: mode === "register" ? auth.recoveryKey : undefined,
      });
      this.connect();
      void this.refreshGroups();
    } catch (err) {
      this.set({ error: this.describeError(err) });
      throw err;
    }
  }

  private describeError(err: unknown): string {
    if (!(err instanceof ApiError)) return "Something went wrong";
    switch (err.code) {
      case "account_locked":
        return "Account locked after suspicious activity. Unlocking needs your recovery key plus the admin key.";
      case "temporarily_locked":
        return "Too many attempts — temporarily locked. Try again shortly.";
      case "invalid_credentials":
        return "Invalid username or password.";
      case "username_taken":
        return "That username is already taken.";
      case "rate_limited":
        return "Too many requests — please slow down.";
      default:
        return err.message;
    }
  }

  dismissRecoveryKey() {
    this.set({ recoveryKey: undefined });
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
    this.groupOut.clear();
    this.groupIn.clear();
    this.set({
      status: "loggedOut",
      identity: undefined,
      conversations: {},
      activeConvId: undefined,
    });
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
  private async saveGroupOut(groupId: string, g: OutboundGroup) {
    await storage.putGroupOut({
      groupId,
      sessionId: g.sessionId,
      pickle: g.session.pickle(this.pickleKey),
      deliveredTo: [...g.deliveredTo],
      memberSig: g.memberSig,
    });
  }

  private async replenishKeys(count: number) {
    if (!this.account || !this.state.identity) return;
    const oneTimeKeys = this.account.generateOneTimeKeys(count);
    this.account.markKeysAsPublished();
    await api.replenish({ oneTimeKeys }, this.id.token).catch(() => undefined);
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

  // ---- conversations -----------------------------------------------------
  setActiveConv(id: string) {
    this.set({ activeConvId: id });
  }

  private async ensureDmConversation(peerUserId: string, username: string) {
    await storage.putConversation({ id: peerUserId, kind: "dm", title: username });
    const existing = this.state.conversations[peerUserId];
    this.upsert({
      id: peerUserId,
      kind: "dm",
      title: username,
      messages: existing?.messages ?? [],
    });
  }

  private async ensureGroupConversation(group: GroupInfo) {
    await storage.putConversation({
      id: group.groupId,
      kind: "group",
      title: group.name,
    });
    const existing = this.state.conversations[group.groupId];
    this.upsert({
      id: group.groupId,
      kind: "group",
      title: group.name,
      members: group.members,
      messages: existing?.messages ?? [],
    });
  }

  private upsert(conv: Conversation) {
    this.set({
      conversations: { ...this.state.conversations, [conv.id]: conv },
    });
  }

  async startConversation(username: string): Promise<string | undefined> {
    try {
      const { userId } = await api.lookup(username, this.id.token);
      await this.ensureDmConversation(userId, username);
      this.set({ activeConvId: userId });
      return userId;
    } catch (err) {
      this.set({ error: err instanceof ApiError ? err.message : "Lookup failed" });
      return undefined;
    }
  }

  async createGroup(name: string, memberUsernames: string[]): Promise<void> {
    try {
      const memberUserIds: string[] = [];
      for (const uname of memberUsernames) {
        const trimmed = uname.trim();
        if (!trimmed) continue;
        const { userId } = await api.lookup(trimmed, this.id.token);
        memberUserIds.push(userId);
      }
      const group = await api.createGroup({ name, memberUserIds }, this.id.token);
      await this.ensureGroupConversation(group);
      this.set({ activeConvId: group.groupId });
    } catch (err) {
      this.set({
        error: err instanceof ApiError ? err.message : "Could not create group",
      });
    }
  }

  // ---- 1:1 sending -------------------------------------------------------
  private async ensureOutboundSession(target: {
    userId: string;
    deviceId: string;
  }): Promise<CryptoSession> {
    const bundle = (await api.claim([target], this.id.token)).bundles[0];
    if (!bundle?.oneTimeKey) throw new Error("Recipient has no available keys");
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

  async sendText(convId: string, text: string): Promise<void> {
    const conv = this.state.conversations[convId];
    if (!conv || !this.account || !text.trim()) return;
    const msgId = crypto.randomUUID();
    const content: MessageContent = {
      kind: "text",
      body: text,
      sentAt: Date.now(),
      msgId,
    };
    const record: StoredMessageRec = {
      id: msgId,
      convId,
      dir: "out",
      body: text,
      sentAt: content.sentAt,
      status: "sending",
    };
    await this.sendContent(conv, content, record);
  }

  async sendAttachment(convId: string, file: File): Promise<void> {
    const conv = this.state.conversations[convId];
    if (!conv || !this.account) return;
    const msgId = crypto.randomUUID();
    try {
      const enc = await encryptFile(file);
      const { blobId } = await api.uploadBlob(enc.ciphertext, this.id.token);
      const meta: AttachmentMeta = {
        name: enc.name,
        mime: enc.mime,
        size: enc.size,
        blobId,
        key: enc.key,
        iv: enc.iv,
        hash: enc.hash,
      };
      const content: MessageContent = {
        kind: "attachment",
        name: meta.name,
        mime: meta.mime,
        size: meta.size,
        blobId,
        key: meta.key,
        nonce: meta.iv,
        hash: meta.hash,
        sentAt: Date.now(),
        msgId,
      };
      const record: StoredMessageRec = {
        id: msgId,
        convId,
        dir: "out",
        body: `📎 ${meta.name}`,
        sentAt: content.sentAt,
        attachment: meta,
        status: "sending",
      };
      await this.sendContent(conv, content, record);
    } catch (err) {
      this.set({
        error: err instanceof Error ? err.message : "Attachment failed",
      });
    }
  }

  /** Deliver any MessageContent (text or attachment) to a dm or group. */
  private async sendContent(
    conv: Conversation,
    content: MessageContent,
    record: StoredMessageRec,
  ): Promise<void> {
    await this.persistAndAppend(conv.id, conv.kind, conv.title, record);
    try {
      if (conv.kind === "group") await this.sendGroupContent(conv.id, content);
      else await this.sendDmContent(conv.id, content, record.id);
      await this.updateMessageStatus(conv.id, record.id, "sent");
    } catch (err) {
      await this.updateMessageStatus(conv.id, record.id, "failed");
      this.set({ error: err instanceof Error ? err.message : "Send failed" });
    }
  }

  private async sendDmContent(
    peerUserId: string,
    content: MessageContent,
    msgId: string,
  ): Promise<void> {
    const { devices } = await api.devices(peerUserId, this.id.token);
    if (devices.length === 0) throw new Error("Recipient has no devices");
    for (const device of devices) {
      await this.sendOlmContent(peerUserId, device, content, msgId);
    }
  }

  /** Download + decrypt an attachment to a Blob for preview/saving. */
  async fetchAttachment(meta: AttachmentMeta): Promise<Blob> {
    const ciphertext = await api.downloadBlob(meta.blobId, this.id.token);
    return decryptToBlob(ciphertext, meta.key, meta.iv, meta.mime);
  }

  /** Encrypt one piece of content to one device over Olm and send it. */
  private async sendOlmContent(
    toUserId: string,
    device: { deviceId: string; identityKey: string },
    content: MessageContent,
    msgId: string,
  ) {
    const session = await this.ensureOutboundSession({
      userId: toUserId,
      deviceId: device.deviceId,
    });
    const enc = session.encrypt(JSON.stringify(content));
    await this.saveSessions(device.identityKey);
    const envelope: EncryptedEnvelope = {
      v: 1,
      alg: "olm",
      msgType: enc.msgType,
      body: enc.body,
      senderIdentityKey: this.myIdentityKey,
    };
    this.sendFrame({
      t: "send",
      message: {
        toUserId,
        toDeviceId: device.deviceId,
        clientMsgId: `${msgId}:${device.deviceId}`,
        envelope,
      },
    });
  }

  // ---- group sending (Megolm) -------------------------------------------
  private async ensureGroupSession(
    groupId: string,
    memberSig: string,
  ): Promise<OutboundGroup> {
    let g = this.groupOut.get(groupId);
    if (!g) {
      const stored = await storage.getGroupOut(groupId);
      if (stored) {
        g = {
          session: GroupSession.unpickle(this.pickleKey, stored.pickle),
          sessionId: stored.sessionId,
          deliveredTo: new Set(stored.deliveredTo),
          memberSig: stored.memberSig,
        };
        this.groupOut.set(groupId, g);
      }
    }
    // Rotate when membership changed (so removed members can't read further).
    if (!g || g.memberSig !== memberSig) {
      const session = GroupSession.create();
      g = {
        session,
        sessionId: session.sessionId(),
        deliveredTo: new Set(),
        memberSig,
      };
      this.groupOut.set(groupId, g);
    }
    return g;
  }

  private async sendGroupContent(
    groupId: string,
    content: MessageContent,
  ): Promise<void> {
    const msgId = "msgId" in content ? content.msgId : crypto.randomUUID();
    const group = await api.getGroup(groupId, this.id.token);
    const memberSig = group.members
      .map((m) => m.userId)
      .sort()
      .join(",");
    const g = await this.ensureGroupSession(groupId, memberSig);

    // Gather every member device except our own current device.
    const targets: Array<{ userId: string; deviceId: string; identityKey: string }> =
      [];
    for (const m of group.members) {
      const { devices } = await api.devices(m.userId, this.id.token);
      for (const d of devices) {
        if (d.identityKey === this.myIdentityKey) continue;
        targets.push({ userId: m.userId, deviceId: d.deviceId, identityKey: d.identityKey });
      }
    }

    // Distribute the group key to any device that doesn't have it yet.
    for (const t of targets) {
      if (g.deliveredTo.has(t.identityKey)) continue;
      const roomKey: MessageContent = {
        kind: "room-key",
        groupId,
        sessionId: g.sessionId,
        sessionKey: g.session.sessionKey(),
      };
      await this.sendOlmContent(t.userId, t, roomKey, `${msgId}-key`);
      g.deliveredTo.add(t.identityKey);
    }

    // Encrypt the message once with Megolm and fan it out to all devices.
    const ciphertext = g.session.encrypt(JSON.stringify(content));
    const envelope: MegolmEnvelope = {
      v: 1,
      alg: "megolm",
      body: ciphertext,
      senderIdentityKey: this.myIdentityKey,
      groupId,
      sessionId: g.sessionId,
    };
    for (const t of targets) {
      this.sendFrame({
        t: "send",
        message: {
          toUserId: t.userId,
          toDeviceId: t.deviceId,
          clientMsgId: `${msgId}:${t.deviceId}`,
          envelope,
        },
      });
    }
    await this.saveGroupOut(groupId, g);
  }

  // ---- receiving ---------------------------------------------------------
  private async handleIncoming(message: StoredMessage): Promise<void> {
    this.sendFrame({ t: "ack", ids: [message.id] });
    try {
      if (message.envelope.alg === "megolm") {
        await this.handleGroupMessage(message, message.envelope);
      } else {
        const plaintext = await this.decryptOlm(message.envelope);
        await this.routeOlmContent(
          message,
          JSON.parse(plaintext) as MessageContent,
        );
      }
    } catch (err) {
      console.warn("failed to handle incoming message", err);
    }
  }

  private async decryptOlm(env: EncryptedEnvelope): Promise<string> {
    if (env.alg !== "olm") throw new Error("not an olm envelope");
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
        /* try next session */
      }
    }
    throw new Error("no matching session for message");
  }

  private async routeOlmContent(message: StoredMessage, content: MessageContent) {
    if (content.kind === "room-key") {
      if (!this.groupIn.has(content.sessionId)) {
        const session = GroupInboundSession.create(content.sessionKey);
        this.groupIn.set(content.sessionId, session);
        await storage.putGroupIn({
          sessionId: content.sessionId,
          groupId: content.groupId,
          pickle: session.pickle(this.pickleKey),
        });
      }
      await this.ensureGroupKnown(content.groupId);
      await this.flushPendingGroup(content.sessionId);
      return;
    }
    if (content.kind === "text" || content.kind === "attachment") {
      const convId = message.fromUserId;
      const username =
        this.state.conversations[convId]?.title ??
        (await this.resolveUsername(convId));
      const record = this.contentToRecord(content, convId, message);
      await this.persistAndAppend(convId, "dm", username, record);
    }
  }

  /** Map a decrypted text/attachment content to a stored message record. */
  private contentToRecord(
    content: MessageContent,
    convId: string,
    message: StoredMessage,
    sender?: string,
  ): StoredMessageRec {
    const base = {
      convId,
      dir: "in" as const,
      sentAt: ("sentAt" in content && content.sentAt) || message.sentAt,
      sender,
    };
    if (content.kind === "attachment") {
      return {
        ...base,
        id: content.msgId || message.id,
        body: `📎 ${content.name}`,
        attachment: {
          name: content.name,
          mime: content.mime,
          size: content.size,
          blobId: content.blobId,
          key: content.key,
          iv: content.nonce,
          hash: content.hash,
        },
      };
    }
    // text
    return {
      ...base,
      id: (content.kind === "text" && content.msgId) || message.id,
      body: content.kind === "text" ? content.body : "",
    };
  }

  private async handleGroupMessage(message: StoredMessage, env: MegolmEnvelope) {
    const session = this.groupIn.get(env.sessionId);
    if (!session) {
      // The room key hasn't arrived yet — buffer and decrypt once it does.
      const queue = this.pendingGroup.get(env.sessionId) ?? [];
      queue.push(message);
      this.pendingGroup.set(env.sessionId, queue);
      await this.ensureGroupKnown(env.groupId);
      return;
    }
    const { plaintext } = session.decrypt(env.body);
    const content = JSON.parse(plaintext) as MessageContent;
    if (content.kind !== "text" && content.kind !== "attachment") return;

    await this.ensureGroupKnown(env.groupId);
    const title = this.state.conversations[env.groupId]?.title ?? "group";
    const sender = await this.resolveUsername(message.fromUserId);
    const record = this.contentToRecord(content, env.groupId, message, sender);
    await this.persistAndAppend(env.groupId, "group", title, record);
  }

  private async flushPendingGroup(sessionId: string) {
    const queue = this.pendingGroup.get(sessionId);
    if (!queue) return;
    this.pendingGroup.delete(sessionId);
    for (const message of queue) {
      if (message.envelope.alg === "megolm") {
        await this.handleGroupMessage(message, message.envelope);
      }
    }
  }

  private async ensureGroupKnown(groupId: string) {
    if (this.state.conversations[groupId]) return;
    try {
      const group = await api.getGroup(groupId, this.id.token);
      await this.ensureGroupConversation(group);
    } catch {
      /* not a member / offline */
    }
  }

  private async resolveUsername(userId: string): Promise<string> {
    if (userId === this.state.identity?.userId) return this.id.username;
    try {
      return (await api.profile(userId, this.id.token)).username;
    } catch {
      return userId.slice(0, 8);
    }
  }

  // ---- conversation state mutation --------------------------------------
  private async persistAndAppend(
    convId: string,
    kind: ConversationKind,
    title: string,
    record: StoredMessageRec,
  ) {
    await storage.putMessage(record);
    const existing = this.state.conversations[convId];
    const messages = existing ? existing.messages.slice() : [];
    if (!messages.some((m) => m.id === record.id)) messages.push(record);
    messages.sort((a, b) => a.sentAt - b.sentAt);
    this.upsert({
      id: convId,
      kind: existing?.kind ?? kind,
      title: existing?.title ?? title,
      members: existing?.members,
      messages,
    });
  }

  private async updateMessageStatus(
    convId: string,
    msgId: string,
    status: ChatMessage["status"],
  ) {
    const conv = this.state.conversations[convId];
    if (!conv) return;
    const messages = conv.messages.map((m) =>
      m.id === msgId ? { ...m, status } : m,
    );
    const updated = messages.find((m) => m.id === msgId);
    if (updated) await storage.putMessage(updated as StoredMessageRec);
    this.upsert({ ...conv, messages });
  }

  fingerprint(): string {
    return this.account ? this.account.identityKeys().ed25519 : "";
  }

  clearError() {
    if (this.state.error) this.set({ error: undefined });
  }
}

export const messenger = new Messenger();
