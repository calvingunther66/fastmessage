/**
 * Verifies the tamper-lockdown + dual-key unlock end to end.
 *
 *   ADMIN_UNLOCK_SECRET=test-admin DATA_DIR=/tmp/x PORT=8093 \
 *     pnpm --filter @fastmessage/server start &
 *   BASE=http://127.0.0.1:8093 ADMIN_UNLOCK_SECRET=test-admin \
 *     pnpm --filter @fastmessage/server exec tsx scripts/lockdown-check.ts
 */
import { createHmac } from "node:crypto";
import { API_V1 } from "@fastmessage/shared";

const BASE = process.env.BASE ?? "http://127.0.0.1:8093";
const ADMIN_SECRET = process.env.ADMIN_UNLOCK_SECRET ?? "test-admin";
const USERNAME = `victim_${Date.now()}`;
const PASSWORD = "correct-horse-battery";

const device = () => ({
  deviceId: crypto.randomUUID(),
  displayName: USERNAME,
  identityKey: "ik",
  signingKey: "sk",
  oneTimeKeys: {},
  fallbackKey: null,
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${API_V1}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Register and capture the one-time recovery key.
const reg = await post("/auth/register", {
  username: USERNAME,
  password: PASSWORD,
  device: device(),
});
if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
const userId = reg.body.userId as string;
const recoveryKey = reg.body.recoveryKey as string;
if (!recoveryKey) throw new Error("no recovery key returned on registration");
console.log("✅ registered; received one-time recovery key");

// Hammer the login with the wrong password until the account hard-locks.
let hardLocked = false;
for (let i = 0; i < 25 && !hardLocked; i++) {
  const r = await post("/auth/login", {
    username: USERNAME,
    password: "wrong-password",
    device: device(),
  });
  if (r.status === 423) hardLocked = true;
}
if (!hardLocked) throw new Error("account did not hard-lock under attack");
console.log("✅ repeated attacks escalated to a hard lockdown (423)");

// Even the correct password is refused while hard-locked.
const correctWhileLocked = await post("/auth/login", {
  username: USERNAME,
  password: PASSWORD,
  device: device(),
});
if (correctWhileLocked.status !== 423) {
  throw new Error(`expected 423 with correct password while locked, got ${correctWhileLocked.status}`);
}
console.log("✅ correct password is still refused while locked");

// One key alone cannot unlock.
const adminToken = createHmac("sha256", ADMIN_SECRET)
  .update(`unlock:${userId}`)
  .digest("hex");

const userKeyOnly = await post("/lockdown/unlock", {
  username: USERNAME,
  recoveryKey,
  adminToken: "not-the-admin-token",
});
if (userKeyOnly.status === 200) throw new Error("unlocked with user key alone!");

const adminKeyOnly = await post("/lockdown/unlock", {
  username: USERNAME,
  recoveryKey: "not-the-recovery-key",
  adminToken,
});
if (adminKeyOnly.status === 200) throw new Error("unlocked with admin key alone!");
console.log("✅ neither key alone can unlock");

// Both keys together unlock.
const both = await post("/lockdown/unlock", {
  username: USERNAME,
  recoveryKey,
  adminToken,
});
if (both.status !== 200) throw new Error(`dual-key unlock failed: ${both.status}`);
console.log("✅ user recovery key + admin token together unlocked the account");

// And now the correct password works again.
const after = await post("/auth/login", {
  username: USERNAME,
  password: PASSWORD,
  device: device(),
});
if (after.status !== 200) throw new Error(`login after unlock failed: ${after.status}`);
console.log("✅ login succeeds again after unlock");
console.log("✅ All lockdown checks passed.");
process.exit(0);
