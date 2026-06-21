import { mkdirSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { config } from "./config.js";

const dataDir = isAbsolute(config.DATA_DIR)
  ? config.DATA_DIR
  : resolve(process.cwd(), config.DATA_DIR);
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(dataDir, "blobs"), { recursive: true });

export const blobDir = join(dataDir, "blobs");

export const db = new Database(join(dataDir, "fastmessage.sqlite"));
// Encrypt the database at rest when a key is configured (must run before any
// other statement). Protects metadata + password/recovery hashes; message
// content is already ciphertext regardless.
if (config.DB_ENCRYPTION_KEY) {
  db.pragma(`key='${config.DB_ENCRYPTION_KEY.replace(/'/g, "''")}'`);
}
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * Schema. Everything the server stores is either public key material or opaque
 * ciphertext + routing metadata. There is no column anywhere that could hold
 * readable message content.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  username_lc   TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  user_id        TEXT NOT NULL,
  id             TEXT NOT NULL,
  display_name   TEXT,
  identity_key   TEXT NOT NULL,   -- public Curve25519
  signing_key    TEXT NOT NULL,   -- public Ed25519 (fingerprint)
  fallback_key_id TEXT,
  fallback_key   TEXT,            -- public last-resort key
  created_at     INTEGER NOT NULL,
  last_seen      INTEGER,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS one_time_keys (
  user_id    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  key_id     TEXT NOT NULL,
  key        TEXT NOT NULL,       -- public Curve25519 one-time key
  claimed    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, key_id),
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_otk_unclaimed
  ON one_time_keys (user_id, device_id, claimed);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Store-and-forward mailbox. The envelope column is E2E ciphertext only.
CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  to_user_id     TEXT NOT NULL,
  to_device_id   TEXT NOT NULL,
  from_user_id   TEXT NOT NULL,
  from_device_id TEXT NOT NULL,
  envelope       TEXT NOT NULL,   -- JSON EncryptedEnvelope (opaque to the server)
  sent_at        INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient
  ON messages (to_user_id, to_device_id, created_at);

-- Group membership is metadata only. Group message *content* is end-to-end
-- encrypted with Megolm and flows through the same ciphertext mailbox above.
CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  role     TEXT NOT NULL DEFAULT 'member',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members (user_id);

-- Per-account security state for the tamper-lockdown system. A hard lock
-- (lock_level = 2) requires the dual-key unlock (user recovery key + admin key).
CREATE TABLE IF NOT EXISTS account_security (
  user_id       TEXT PRIMARY KEY,
  recovery_hash TEXT NOT NULL,         -- hash of the user's recovery key
  failed_logins INTEGER NOT NULL DEFAULT 0,
  last_failed_at INTEGER,
  lock_level    INTEGER NOT NULL DEFAULT 0,  -- 0 normal, 1 soft (timed), 2 hard
  locked_until  INTEGER,               -- soft-lock expiry
  tamper_score  INTEGER NOT NULL DEFAULT 0,  -- escalates with attempts while locked
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Web Push subscriptions per device (content-free wake notifications).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_push_user_device ON push_subscriptions (user_id, device_id);
`);
