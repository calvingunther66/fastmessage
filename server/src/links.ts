import { randomBytes } from "node:crypto";

/**
 * Short-lived, single-use device-link codes held in memory. An already
 * signed-in device mints one; a new device redeems it to join the same account
 * without the password. Codes expire quickly and are consumed on use.
 */
interface Link {
  userId: string;
  expiresAt: number;
}

const TTL_MS = 2 * 60 * 1000;
// No ambiguous characters (0/O, 1/I) so codes are easy to read off a screen.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const links = new Map<string, Link>();

function cleanup() {
  const now = Date.now();
  for (const [code, link] of links) if (link.expiresAt < now) links.delete(code);
}

function newCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
  return code;
}

export function createLink(userId: string): { code: string; expiresAt: number } {
  cleanup();
  const code = newCode();
  const expiresAt = Date.now() + TTL_MS;
  links.set(code, { userId, expiresAt });
  return { code, expiresAt };
}

/** Validate + consume a code, returning the account's user id or null. */
export function consumeLink(code: string): string | null {
  cleanup();
  const key = code.trim().toUpperCase();
  const link = links.get(key);
  if (!link) return null;
  links.delete(key);
  if (link.expiresAt < Date.now()) return null;
  return link.userId;
}
