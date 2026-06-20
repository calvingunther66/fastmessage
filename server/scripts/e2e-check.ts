/**
 * End-to-end smoke + trust-model check. Run against a live server:
 *
 *   DATA_DIR=/tmp/fmtest PORT=8099 pnpm --filter @fastmessage/server start &
 *   BASE=http://127.0.0.1:8099 DB=/tmp/fmtest/fastmessage.sqlite \
 *     pnpm --filter @fastmessage/server exec tsx scripts/e2e-check.ts
 *
 * It registers two users, has Alice send Bob an E2E-encrypted message over the
 * WebSocket, confirms Bob decrypts it, and then opens the server's SQLite file
 * directly to assert the stored envelope contains ONLY ciphertext — proving the
 * server operator cannot read messages.
 */
import Database from "better-sqlite3";
import { CryptoAccount, initCrypto } from "@fastmessage/crypto";
import { API_V1, WS_PATH } from "@fastmessage/shared";

const BASE = process.env.BASE ?? "http://127.0.0.1:8099";
const DB = process.env.DB ?? "/tmp/fmtest/fastmessage.sqlite";
const SECRET = "super-secret-hello-do-not-leak-42";

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

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function openSocket(token: string): Promise<WebSocket> {
  const url = `${BASE.replace(/^http/, "ws")}${WS_PATH}?token=${token}`;
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
  });
}

const alice = await register("alice");
const bob = await register("bob");

// Alice resolves Bob and claims a prekey bundle for his device.
const lookup = (await (
  await fetch(`${BASE}${API_V1}/users/lookup?username=bob`, {
    headers: authHeaders(alice.auth.token),
  })
).json()) as { userId: string };

const claim = (await (
  await fetch(`${BASE}${API_V1}/keys/claim`, {
    method: "POST",
    headers: authHeaders(alice.auth.token),
    body: JSON.stringify({
      targets: [{ userId: lookup.userId, deviceId: bob.deviceId }],
    }),
  })
).json()) as { bundles: Array<{ identityKey: string; oneTimeKey: { key: string } }> };

const bundle = claim.bundles[0];
if (!bundle?.oneTimeKey) throw new Error("no prekey bundle returned");

// Alice encrypts a message to Bob's device.
const session = alice.acct.createOutboundSession(
  bundle.identityKey,
  bundle.oneTimeKey.key,
);
const content = {
  kind: "text",
  body: SECRET,
  sentAt: Date.now(),
  msgId: crypto.randomUUID(),
};
const enc = session.encrypt(JSON.stringify(content));
const envelope = {
  v: 1 as const,
  alg: "olm" as const,
  msgType: enc.msgType,
  body: enc.body,
  senderIdentityKey: alice.acct.identityKeys().curve25519,
};

// Bob connects and waits for the message.
const bobSocket = await openSocket(bob.auth.token);
const received = new Promise<{ envelope: typeof envelope }>((resolve, reject) => {
  bobSocket.onmessage = (ev) => {
    const frame = JSON.parse(String(ev.data));
    if (frame.t === "message") resolve(frame.message);
  };
  setTimeout(() => reject(new Error("timed out waiting for message")), 8000);
});

// Alice sends over the WebSocket.
const aliceSocket = await openSocket(alice.auth.token);
aliceSocket.send(
  JSON.stringify({
    t: "send",
    message: {
      toUserId: lookup.userId,
      toDeviceId: bob.deviceId,
      clientMsgId: crypto.randomUUID(),
      envelope,
    },
  }),
);

const message = await received;

// Bob decrypts.
const { plaintext } = bob.acct.createInboundSession(
  message.envelope.senderIdentityKey,
  message.envelope.body,
);
const decoded = JSON.parse(plaintext) as { body: string };
if (decoded.body !== SECRET) {
  throw new Error(`decrypt mismatch: got ${plaintext}`);
}
console.log(`✅ Bob decrypted Alice's message: "${decoded.body}"`);

// Trust-model assertion: the plaintext must NOT appear anywhere in the DB.
bobSocket.close();
aliceSocket.close();

const sqlite = new Database(DB, { readonly: true });
const rows = sqlite.prepare("SELECT envelope FROM messages").all() as Array<{ envelope: string }>;
if (rows.length === 0) throw new Error("expected a stored ciphertext envelope");
for (const row of rows) {
  if (row.envelope.includes(SECRET)) {
    throw new Error("❌ TRUST VIOLATION: plaintext found in server DB");
  }
}
console.log(
  `✅ Server stored ${rows.length} envelope(s), none containing the plaintext.`,
);
console.log("✅ All end-to-end checks passed.");
process.exit(0);
