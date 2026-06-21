/**
 * End-to-end smoke + trust-model check. Run against a live server:
 *
 *   DATA_DIR=/tmp/fmtest PORT=8099 pnpm --filter @fastmessage/server start &
 *   BASE=http://127.0.0.1:8099 DB=/tmp/fmtest/fastmessage.sqlite \
 *     pnpm --filter @fastmessage/server exec tsx scripts/e2e-check.ts
 *
 * Covers a 1:1 Olm exchange and a group Megolm exchange, then opens the
 * server's SQLite file to assert no plaintext is stored anywhere — proving the
 * operator cannot read messages.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  CryptoAccount,
  GroupInboundSession,
  GroupSession,
  initCrypto,
} from "@fastmessage/crypto";
import { API_V1, WS_PATH } from "@fastmessage/shared";

const BASE = process.env.BASE ?? "http://127.0.0.1:8099";
const DB = process.env.DB ?? "/tmp/fmtest/fastmessage.sqlite";
const DM_SECRET = "super-secret-dm-do-not-leak-42";
const GROUP_SECRET = "super-secret-group-do-not-leak-99";

await initCrypto();

interface Registered {
  acct: CryptoAccount;
  deviceId: string;
  auth: { token: string; userId: string };
}

async function register(username: string): Promise<Registered> {
  const acct = CryptoAccount.create();
  const ik = acct.identityKeys();
  const oneTimeKeys = acct.generateOneTimeKeys(5);
  acct.markKeysAsPublished();
  const fallbackKey = acct.generateFallbackKey();
  const deviceId = crypto.randomUUID();
  const res = await fetch(`${BASE}${API_V1}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username,
      password: "password123",
      device: {
        deviceId,
        displayName: username,
        identityKey: ik.curve25519,
        signingKey: ik.ed25519,
        oneTimeKeys,
        fallbackKey,
      },
    }),
  });
  if (!res.ok) throw new Error(`register ${username}: ${res.status} ${await res.text()}`);
  const auth = (await res.json()) as { token: string; userId: string };
  return { acct, deviceId, auth };
}

const H = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});
const get = async <T>(path: string, token: string): Promise<T> =>
  (await fetch(`${BASE}${API_V1}${path}`, { headers: H(token) })).json() as Promise<T>;
const post = async <T>(path: string, token: string, body: unknown): Promise<T> =>
  (await fetch(`${BASE}${API_V1}${path}`, {
    method: "POST",
    headers: H(token),
    body: JSON.stringify(body),
  })).json() as Promise<T>;

function openSocket(token: string): Promise<WebSocket> {
  const url = `${BASE.replace(/^http/, "ws")}${WS_PATH}?token=${token}`;
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
  });
}

// A queue so we can await individual delivered messages in order.
function messageQueue(ws: WebSocket) {
  const buffer: any[] = [];
  const waiters: Array<(m: any) => void> = [];
  ws.onmessage = (ev) => {
    const frame = JSON.parse(String(ev.data));
    if (frame.t !== "message") return;
    const w = waiters.shift();
    if (w) w(frame.message);
    else buffer.push(frame.message);
  };
  return (timeoutMs = 8000): Promise<any> => {
    const queued = buffer.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  };
}

const alice = await register("alice");
const bob = await register("bob");
const aliceSocket = await openSocket(alice.auth.token);
const bobSocket = await openSocket(bob.auth.token);
const nextForBob = messageQueue(bobSocket);

const send = (to: Registered, envelope: unknown) =>
  aliceSocket.send(
    JSON.stringify({
      t: "send",
      message: {
        toUserId: to.auth.userId,
        toDeviceId: to.deviceId,
        clientMsgId: crypto.randomUUID(),
        envelope,
      },
    }),
  );

const senderKey = alice.acct.identityKeys().curve25519;

// ---- 1:1 Olm ------------------------------------------------------------
const claim = await post<{
  bundles: Array<{ identityKey: string; oneTimeKey: { key: string } }>;
}>("/keys/claim", alice.auth.token, {
  targets: [{ userId: bob.auth.userId, deviceId: bob.deviceId }],
});
const bundle = claim.bundles[0];
if (!bundle?.oneTimeKey) throw new Error("no prekey bundle");

const aliceToBob = alice.acct.createOutboundSession(
  bundle.identityKey,
  bundle.oneTimeKey.key,
);
const dmEnc = aliceToBob.encrypt(
  JSON.stringify({ kind: "text", body: DM_SECRET, sentAt: Date.now(), msgId: "1" }),
);
send(bob, {
  v: 1,
  alg: "olm",
  msgType: dmEnc.msgType,
  body: dmEnc.body,
  senderIdentityKey: senderKey,
});

const dm = await nextForBob();
const bobInboundResult = bob.acct.createInboundSession(
  dm.envelope.senderIdentityKey,
  dm.envelope.body,
);
const bobInbound = bobInboundResult.session;
if (JSON.parse(bobInboundResult.plaintext).body !== DM_SECRET) {
  throw new Error("dm decrypt failed");
}
console.log(`✅ 1:1: Bob decrypted "${DM_SECRET}"`);

// ---- Group Megolm -------------------------------------------------------
const group = await post<{ groupId: string }>("/groups", alice.auth.token, {
  name: "secret club",
  memberUserIds: [bob.auth.userId],
});

const groupSession = GroupSession.create();
// Distribute the room key over the existing 1:1 Olm session (key at index 0).
const keyMsg = aliceToBob.encrypt(
  JSON.stringify({
    kind: "room-key",
    groupId: group.groupId,
    sessionId: groupSession.sessionId(),
    sessionKey: groupSession.sessionKey(),
  }),
);
send(bob, {
  v: 1,
  alg: "olm",
  msgType: keyMsg.msgType,
  body: keyMsg.body,
  senderIdentityKey: senderKey,
});

// Encrypt the group message with Megolm and send it.
const groupCt = groupSession.encrypt(
  JSON.stringify({ kind: "text", body: GROUP_SECRET, sentAt: Date.now(), msgId: "g1" }),
);
send(bob, {
  v: 1,
  alg: "megolm",
  body: groupCt,
  senderIdentityKey: senderKey,
  groupId: group.groupId,
  sessionId: groupSession.sessionId(),
});

// Bob processes the two deliveries (room key, then the group message).
let inbound: GroupInboundSession | null = null;
let groupDecrypted: string | null = null;
for (let i = 0; i < 2; i++) {
  const m = await nextForBob();
  if (m.envelope.alg === "olm") {
    const content = JSON.parse(
      bobInbound.decrypt(m.envelope.msgType, m.envelope.body),
    );
    if (content.kind === "room-key") {
      inbound = GroupInboundSession.create(content.sessionKey);
    }
  } else if (m.envelope.alg === "megolm") {
    if (!inbound) throw new Error("group message arrived before room key");
    groupDecrypted = JSON.parse(inbound.decrypt(m.envelope.body).plaintext).body;
  }
}
if (groupDecrypted !== GROUP_SECRET) throw new Error("group decrypt failed");
console.log(`✅ group: Bob decrypted "${GROUP_SECRET}"`);

// ---- Encrypted attachment (AES-GCM blob) -------------------------------
const ATT_SECRET = "attachment-bytes-super-secret-stuff";
{
  const data = new TextEncoder().encode(ATT_SECRET);
  const fileKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, fileKey, data),
  );

  const up = await fetch(`${BASE}${API_V1}/blobs`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      authorization: `Bearer ${alice.auth.token}`,
    },
    body: ct,
  });
  const { blobId } = (await up.json()) as { blobId: string };

  // Bob downloads the ciphertext and decrypts with the key (as if from a message).
  const down = await fetch(`${BASE}${API_V1}/blobs/${blobId}`, {
    headers: { authorization: `Bearer ${bob.auth.token}` },
  });
  const ct2 = new Uint8Array(await down.arrayBuffer());
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, fileKey, ct2),
  );
  if (new TextDecoder().decode(pt) !== ATT_SECRET) {
    throw new Error("attachment decrypt failed");
  }

  // The blob on disk must be ciphertext only.
  const onDisk = readFileSync(join(dirname(DB), "blobs", blobId));
  if (onDisk.toString("latin1").includes(ATT_SECRET)) {
    throw new Error("❌ TRUST VIOLATION: attachment plaintext on disk");
  }
  console.log(`✅ attachment: round-trip ok, blob on disk is ciphertext only`);
}

aliceSocket.close();
bobSocket.close();

// ---- Trust-model assertion ---------------------------------------------
const sqlite = new Database(DB, { readonly: true });
const rows = sqlite.prepare("SELECT envelope FROM messages").all() as Array<{
  envelope: string;
}>;
if (rows.length === 0) throw new Error("expected stored ciphertext envelopes");
for (const row of rows) {
  if (row.envelope.includes(DM_SECRET) || row.envelope.includes(GROUP_SECRET)) {
    throw new Error("❌ TRUST VIOLATION: plaintext found in server DB");
  }
}
console.log(
  `✅ Server stored ${rows.length} envelope(s), none containing any plaintext.`,
);
console.log("✅ All end-to-end checks passed.");
process.exit(0);
