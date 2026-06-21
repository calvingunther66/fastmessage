import { randomUUID } from "node:crypto";
import type {
  DevicePublicKeys,
  EncryptedEnvelope,
  GroupInfo,
  GroupMember,
  GroupRole,
  OneTimeKey,
  StoredMessage,
} from "@fastmessage/shared";
import { db } from "./db.js";

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  username: string;
  username_lc: string;
  password_hash: string;
  created_at: number;
}

const insertUser = db.prepare(
  `INSERT INTO users (id, username, username_lc, password_hash, created_at)
   VALUES (@id, @username, @username_lc, @password_hash, @created_at)`,
);
const selectUserByUsernameLc = db.prepare(
  `SELECT * FROM users WHERE username_lc = ?`,
);
const selectUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);

export const users = {
  create(username: string, passwordHash: string): UserRow {
    const row: UserRow = {
      id: randomUUID(),
      username,
      username_lc: username.toLowerCase(),
      password_hash: passwordHash,
      created_at: Date.now(),
    };
    insertUser.run(row);
    return row;
  },
  byUsername(username: string): UserRow | undefined {
    return selectUserByUsernameLc.get(username.toLowerCase()) as
      | UserRow
      | undefined;
  },
  byId(id: string): UserRow | undefined {
    return selectUserById.get(id) as UserRow | undefined;
  },
};

// ---------------------------------------------------------------------------
// Devices + key directory
// ---------------------------------------------------------------------------

interface DeviceRow {
  user_id: string;
  id: string;
  display_name: string | null;
  identity_key: string;
  signing_key: string;
  fallback_key_id: string | null;
  fallback_key: string | null;
  created_at: number;
  last_seen: number | null;
}

const upsertDeviceStmt = db.prepare(
  `INSERT INTO devices (user_id, id, display_name, identity_key, signing_key,
        fallback_key_id, fallback_key, created_at, last_seen)
   VALUES (@user_id, @id, @display_name, @identity_key, @signing_key,
        @fallback_key_id, @fallback_key, @created_at, @last_seen)
   ON CONFLICT(user_id, id) DO UPDATE SET
     display_name = excluded.display_name,
     identity_key = excluded.identity_key,
     signing_key  = excluded.signing_key,
     fallback_key_id = COALESCE(excluded.fallback_key_id, devices.fallback_key_id),
     fallback_key    = COALESCE(excluded.fallback_key, devices.fallback_key),
     last_seen    = excluded.last_seen`,
);
const selectDevices = db.prepare(`SELECT * FROM devices WHERE user_id = ?`);
const selectDevice = db.prepare(
  `SELECT * FROM devices WHERE user_id = ? AND id = ?`,
);
const touchDeviceStmt = db.prepare(
  `UPDATE devices SET last_seen = ? WHERE user_id = ? AND id = ?`,
);
const setFallbackStmt = db.prepare(
  `UPDATE devices SET fallback_key_id = ?, fallback_key = ? WHERE user_id = ? AND id = ?`,
);

function toPublic(row: DeviceRow): DevicePublicKeys {
  return {
    deviceId: row.id,
    displayName: row.display_name ?? undefined,
    identityKey: row.identity_key,
    signingKey: row.signing_key,
  };
}

export const devices = {
  upsert(d: {
    userId: string;
    deviceId: string;
    displayName?: string;
    identityKey: string;
    signingKey: string;
    fallbackKey?: OneTimeKey | null;
  }) {
    upsertDeviceStmt.run({
      user_id: d.userId,
      id: d.deviceId,
      display_name: d.displayName ?? null,
      identity_key: d.identityKey,
      signing_key: d.signingKey,
      fallback_key_id: d.fallbackKey?.keyId ?? null,
      fallback_key: d.fallbackKey?.key ?? null,
      created_at: Date.now(),
      last_seen: Date.now(),
    });
  },
  list(userId: string): DevicePublicKeys[] {
    return (selectDevices.all(userId) as DeviceRow[]).map(toPublic);
  },
  get(userId: string, deviceId: string): DeviceRow | undefined {
    return selectDevice.get(userId, deviceId) as DeviceRow | undefined;
  },
  touch(userId: string, deviceId: string) {
    touchDeviceStmt.run(Date.now(), userId, deviceId);
  },
  setFallback(userId: string, deviceId: string, fb: OneTimeKey) {
    setFallbackStmt.run(fb.keyId, fb.key, userId, deviceId);
  },
};

// ---------------------------------------------------------------------------
// One-time keys
// ---------------------------------------------------------------------------

const insertOtk = db.prepare(
  `INSERT OR IGNORE INTO one_time_keys (user_id, device_id, key_id, key, claimed, created_at)
   VALUES (?, ?, ?, ?, 0, ?)`,
);
const selectUnclaimedOtk = db.prepare(
  `SELECT key_id, key FROM one_time_keys
   WHERE user_id = ? AND device_id = ? AND claimed = 0
   ORDER BY created_at LIMIT 1`,
);
const markOtkClaimed = db.prepare(
  `UPDATE one_time_keys SET claimed = 1
   WHERE user_id = ? AND device_id = ? AND key_id = ?`,
);
const countUnclaimedOtk = db.prepare(
  `SELECT COUNT(*) AS n FROM one_time_keys
   WHERE user_id = ? AND device_id = ? AND claimed = 0`,
);

export const oneTimeKeys = {
  add(userId: string, deviceId: string, keys: Record<string, string>) {
    const now = Date.now();
    const tx = db.transaction(() => {
      for (const [keyId, key] of Object.entries(keys)) {
        insertOtk.run(userId, deviceId, keyId, key, now);
      }
    });
    tx();
  },
  /** Atomically claim one unclaimed one-time key, marking it consumed. */
  claim(userId: string, deviceId: string): OneTimeKey | null {
    const tx = db.transaction((): OneTimeKey | null => {
      const row = selectUnclaimedOtk.get(userId, deviceId) as
        | { key_id: string; key: string }
        | undefined;
      if (!row) return null;
      markOtkClaimed.run(userId, deviceId, row.key_id);
      return { keyId: row.key_id, key: row.key };
    });
    return tx();
  },
  countUnclaimed(userId: string, deviceId: string): number {
    return (countUnclaimedOtk.get(userId, deviceId) as { n: number }).n;
  },
};

// ---------------------------------------------------------------------------
// Auth sessions (opaque tokens)
// ---------------------------------------------------------------------------

const insertSession = db.prepare(
  `INSERT INTO auth_sessions (token_hash, user_id, device_id, created_at, expires_at)
   VALUES (?, ?, ?, ?, ?)`,
);
const selectSession = db.prepare(
  `SELECT user_id, device_id, expires_at FROM auth_sessions WHERE token_hash = ?`,
);
const deleteSessionStmt = db.prepare(
  `DELETE FROM auth_sessions WHERE token_hash = ?`,
);
const deleteSessionsForUserStmt = db.prepare(
  `DELETE FROM auth_sessions WHERE user_id = ?`,
);

export const authSessions = {
  create(
    tokenHash: string,
    userId: string,
    deviceId: string,
    expiresAt: number,
  ) {
    insertSession.run(tokenHash, userId, deviceId, Date.now(), expiresAt);
  },
  get(tokenHash: string):
    | { userId: string; deviceId: string; expiresAt: number }
    | undefined {
    const row = selectSession.get(tokenHash) as
      | { user_id: string; device_id: string; expires_at: number }
      | undefined;
    if (!row) return undefined;
    return {
      userId: row.user_id,
      deviceId: row.device_id,
      expiresAt: row.expires_at,
    };
  },
  delete(tokenHash: string) {
    deleteSessionStmt.run(tokenHash);
  },
  /** Revoke every active session for a user (used when an account hard-locks). */
  deleteAllForUser(userId: string) {
    deleteSessionsForUserStmt.run(userId);
  },
};

// ---------------------------------------------------------------------------
// Message mailbox (store-and-forward; ciphertext only)
// ---------------------------------------------------------------------------

interface MessageRow {
  id: string;
  to_user_id: string;
  to_device_id: string;
  from_user_id: string;
  from_device_id: string;
  envelope: string;
  sent_at: number;
  created_at: number;
}

const insertMessage = db.prepare(
  `INSERT INTO messages (id, to_user_id, to_device_id, from_user_id, from_device_id, envelope, sent_at, created_at)
   VALUES (@id, @to_user_id, @to_device_id, @from_user_id, @from_device_id, @envelope, @sent_at, @created_at)`,
);
const selectMessagesFor = db.prepare(
  `SELECT * FROM messages WHERE to_user_id = ? AND to_device_id = ? ORDER BY created_at`,
);
const deleteMessageStmt = db.prepare(
  `DELETE FROM messages WHERE id = ? AND to_user_id = ? AND to_device_id = ?`,
);

export const messages = {
  enqueue(m: {
    toUserId: string;
    toDeviceId: string;
    fromUserId: string;
    fromDeviceId: string;
    envelope: EncryptedEnvelope;
    sentAt: number;
  }): StoredMessage {
    const id = randomUUID();
    const now = Date.now();
    insertMessage.run({
      id,
      to_user_id: m.toUserId,
      to_device_id: m.toDeviceId,
      from_user_id: m.fromUserId,
      from_device_id: m.fromDeviceId,
      envelope: JSON.stringify(m.envelope),
      sent_at: m.sentAt,
      created_at: now,
    });
    return {
      id,
      fromUserId: m.fromUserId,
      fromDeviceId: m.fromDeviceId,
      envelope: m.envelope,
      sentAt: m.sentAt,
    };
  },
  listFor(userId: string, deviceId: string): StoredMessage[] {
    return (selectMessagesFor.all(userId, deviceId) as MessageRow[]).map(
      (row) => ({
        id: row.id,
        fromUserId: row.from_user_id,
        fromDeviceId: row.from_device_id,
        envelope: JSON.parse(row.envelope) as EncryptedEnvelope,
        sentAt: row.sent_at,
      }),
    );
  },
  /** Delete acked messages, but only those actually addressed to this device. */
  ackDelete(ids: string[], userId: string, deviceId: string) {
    const tx = db.transaction(() => {
      for (const id of ids) deleteMessageStmt.run(id, userId, deviceId);
    });
    tx();
  },
};

// ---------------------------------------------------------------------------
// Groups (membership metadata only)
// ---------------------------------------------------------------------------

interface GroupRow {
  id: string;
  name: string;
  created_by: string;
  created_at: number;
}

const insertGroup = db.prepare(
  `INSERT INTO groups (id, name, created_by, created_at) VALUES (?, ?, ?, ?)`,
);
const selectGroup = db.prepare(`SELECT * FROM groups WHERE id = ?`);
const insertMember = db.prepare(
  `INSERT OR IGNORE INTO group_members (group_id, user_id, role, added_at)
   VALUES (?, ?, ?, ?)`,
);
const deleteMember = db.prepare(
  `DELETE FROM group_members WHERE group_id = ? AND user_id = ?`,
);
const selectMembers = db.prepare(
  `SELECT gm.user_id, gm.role, u.username
   FROM group_members gm JOIN users u ON u.id = gm.user_id
   WHERE gm.group_id = ? ORDER BY gm.added_at`,
);
const selectGroupsForUser = db.prepare(
  `SELECT g.* FROM groups g
   JOIN group_members gm ON gm.group_id = g.id
   WHERE gm.user_id = ? ORDER BY g.created_at`,
);
const selectIsMember = db.prepare(
  `SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?`,
);

function membersOf(groupId: string): GroupMember[] {
  return (
    selectMembers.all(groupId) as Array<{
      user_id: string;
      role: string;
      username: string;
    }>
  ).map((r) => ({
    userId: r.user_id,
    username: r.username,
    role: r.role as GroupRole,
  }));
}

function toGroupInfo(row: GroupRow): GroupInfo {
  return {
    groupId: row.id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    members: membersOf(row.id),
  };
}

// ---------------------------------------------------------------------------
// Web Push subscriptions
// ---------------------------------------------------------------------------

export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const insertPushSub = db.prepare(
  `INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, device_id, p256dh, auth, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const selectPushForDevice = db.prepare(
  `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND device_id = ?`,
);
const deletePushSub = db.prepare(
  `DELETE FROM push_subscriptions WHERE endpoint = ?`,
);

export const pushSubs = {
  add(userId: string, deviceId: string, sub: PushSub) {
    insertPushSub.run(sub.endpoint, userId, deviceId, sub.p256dh, sub.auth, Date.now());
  },
  listForDevice(userId: string, deviceId: string): PushSub[] {
    return selectPushForDevice.all(userId, deviceId) as PushSub[];
  },
  delete(endpoint: string) {
    deletePushSub.run(endpoint);
  },
};

export const groups = {
  create(name: string, createdBy: string): GroupInfo {
    const id = randomUUID();
    const now = Date.now();
    const tx = db.transaction(() => {
      insertGroup.run(id, name, createdBy, now);
      insertMember.run(id, createdBy, "admin", now);
    });
    tx();
    return toGroupInfo(selectGroup.get(id) as GroupRow);
  },
  get(groupId: string): GroupInfo | undefined {
    const row = selectGroup.get(groupId) as GroupRow | undefined;
    return row ? toGroupInfo(row) : undefined;
  },
  addMember(groupId: string, userId: string, role: GroupRole = "member") {
    insertMember.run(groupId, userId, role, Date.now());
  },
  removeMember(groupId: string, userId: string) {
    deleteMember.run(groupId, userId);
  },
  isMember(groupId: string, userId: string): boolean {
    return selectIsMember.get(groupId, userId) !== undefined;
  },
  listForUser(userId: string): GroupInfo[] {
    return (selectGroupsForUser.all(userId) as GroupRow[]).map(toGroupInfo);
  },
  members(groupId: string): GroupMember[] {
    return membersOf(groupId);
  },
};
