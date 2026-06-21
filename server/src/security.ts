/**
 * Tamper-lockdown with dual-key unlock.
 *
 * Repeated failed/abusive access escalates an account through:
 *   level 0  normal
 *   level 1  soft lock — a timed cool-off that grows with the tamper score
 *   level 2  hard lock — sessions revoked; reopening requires BOTH the user's
 *            recovery key AND an admin key (two-person control).
 *
 * Every attempt against a locked account raises the tamper score, which extends
 * future cool-offs — i.e. it "locks down even more" the more it is poked. This
 * is purely defensive: it restricts access, it never attacks the requester.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { authSessions } from "./repo.js";

export type LockLevel = 0 | 1 | 2;

export interface LockState {
  level: LockLevel;
  lockedUntil: number | null;
  tamperScore: number;
}

interface SecurityRow {
  user_id: string;
  recovery_hash: string;
  failed_logins: number;
  last_failed_at: number | null;
  lock_level: number;
  locked_until: number | null;
  tamper_score: number;
  updated_at: number;
}

const selectSecurity = db.prepare(`SELECT * FROM account_security WHERE user_id = ?`);
const insertSecurity = db.prepare(
  `INSERT OR REPLACE INTO account_security
     (user_id, recovery_hash, failed_logins, last_failed_at, lock_level, locked_until, tamper_score, updated_at)
   VALUES (@user_id, @recovery_hash, @failed_logins, @last_failed_at, @lock_level, @locked_until, @tamper_score, @updated_at)`,
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function load(userId: string): SecurityRow | undefined {
  return selectSecurity.get(userId) as SecurityRow | undefined;
}

function save(row: SecurityRow) {
  row.updated_at = Date.now();
  insertSecurity.run(row);
}

/** Create the security row for a new account and return the one-time recovery key. */
export function provisionAccount(userId: string): string {
  const recoveryKey = randomBytes(24).toString("base64url");
  save({
    user_id: userId,
    recovery_hash: sha256(recoveryKey),
    failed_logins: 0,
    last_failed_at: null,
    lock_level: 0,
    locked_until: null,
    tamper_score: 0,
    updated_at: Date.now(),
  });
  return recoveryKey;
}

/** The effective lock state right now (soft locks expire on their own). */
export function lockState(userId: string): LockState {
  const row = load(userId);
  if (!row) return { level: 0, lockedUntil: null, tamperScore: 0 };
  if (row.lock_level === 2) {
    return { level: 2, lockedUntil: null, tamperScore: row.tamper_score };
  }
  if (row.lock_level === 1 && row.locked_until && row.locked_until > Date.now()) {
    return { level: 1, lockedUntil: row.locked_until, tamperScore: row.tamper_score };
  }
  return { level: 0, lockedUntil: null, tamperScore: row.tamper_score };
}

export function isHardLocked(userId: string): boolean {
  return load(userId)?.lock_level === 2;
}

/** Record a failed login and escalate the lock if thresholds are crossed. */
export function recordFailure(userId: string): LockState {
  const row = load(userId);
  if (!row) return { level: 0, lockedUntil: null, tamperScore: 0 };
  const now = Date.now();
  const { softFailThreshold, hardFailThreshold, failWindowMs, softLockBaseMs } =
    config.security;

  // Reset the counter if the previous failure is outside the window.
  if (row.last_failed_at && now - row.last_failed_at > failWindowMs) {
    row.failed_logins = 0;
  }
  row.failed_logins += 1;
  row.last_failed_at = now;

  if (row.failed_logins >= hardFailThreshold) {
    row.lock_level = 2;
    row.locked_until = null;
    authSessions.deleteAllForUser(userId); // revoke everything on hard lock
  } else if (row.failed_logins >= softFailThreshold) {
    row.lock_level = 1;
    const over = row.failed_logins - softFailThreshold;
    const backoff = softLockBaseMs * 2 ** Math.min(over + row.tamper_score, 10);
    row.locked_until = now + backoff;
  }
  save(row);
  return lockState(userId);
}

/** Clear soft counters after a genuine success (a hard lock is never cleared here). */
export function recordSuccess(userId: string): void {
  const row = load(userId);
  if (!row || row.lock_level === 2) return;
  row.failed_logins = 0;
  row.lock_level = 0;
  row.locked_until = null;
  save(row);
}

/** An access attempt against a locked account: raise the tamper score, extend
 * the cool-off, and escalate a soft lock to a hard lock if the probing
 * persists. This is the "locks down even more" behaviour. */
export function registerTamper(userId: string): void {
  const row = load(userId);
  if (!row) return;
  row.tamper_score += 1;

  if (row.tamper_score >= config.security.hardFailThreshold && row.lock_level < 2) {
    row.lock_level = 2; // persistent probing => dual-key hard lock
    row.locked_until = null;
    authSessions.deleteAllForUser(userId);
  } else if (row.lock_level === 1 && row.locked_until) {
    row.locked_until = Math.max(
      row.locked_until,
      Date.now() + config.security.softLockBaseMs * 2 ** Math.min(row.tamper_score, 10),
    );
  }
  save(row);
}

/** The admin half of the dual key — derived from ADMIN_UNLOCK_SECRET per user. */
export function expectedAdminToken(userId: string): string | null {
  if (!config.ADMIN_UNLOCK_SECRET) return null;
  return createHmac("sha256", config.ADMIN_UNLOCK_SECRET)
    .update(`unlock:${userId}`)
    .digest("hex");
}

/**
 * Dual-key unlock. Requires the user's recovery key AND the admin token.
 * A failed attempt is itself treated as tampering.
 */
export function unlock(
  userId: string,
  recoveryKey: string,
  adminToken: string,
): { ok: boolean; reason?: string } {
  const row = load(userId);
  if (!row) return { ok: false, reason: "unknown_account" };

  const expectedAdmin = expectedAdminToken(userId);
  if (!expectedAdmin) return { ok: false, reason: "admin_unlock_disabled" };

  const userOk = safeEqualHex(sha256(recoveryKey), row.recovery_hash);
  const adminOk = safeEqualHex(adminToken, expectedAdmin);
  if (!userOk || !adminOk) {
    registerTamper(userId);
    return { ok: false, reason: "invalid_keys" };
  }

  row.failed_logins = 0;
  row.lock_level = 0;
  row.locked_until = null;
  row.tamper_score = 0;
  save(row);
  return { ok: true };
}
