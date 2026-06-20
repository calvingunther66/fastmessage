import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { config } from "./config.js";
import { authSessions } from "./repo.js";

export interface AuthContext {
  userId: string;
  deviceId: string;
}

/** Opaque tokens are stored only as a peppered SHA-256 hash. */
function hashToken(token: string): string {
  return createHash("sha256")
    .update(`${token}.${config.SESSION_SECRET}`)
    .digest("hex");
}

export function issueToken(
  userId: string,
  deviceId: string,
): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + config.tokenTtlMs;
  authSessions.create(hashToken(token), userId, deviceId, expiresAt);
  return { token, expiresAt };
}

export function verifyToken(token: string): AuthContext | null {
  if (!token) return null;
  const h = hashToken(token);
  const row = authSessions.get(h);
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    authSessions.delete(h);
    return null;
  }
  return { userId: row.userId, deviceId: row.deviceId };
}

export function revokeToken(token: string): void {
  authSessions.delete(hashToken(token));
}

/** Extract + verify a Bearer token from a request, or null. */
export function authFromRequest(req: FastifyRequest): AuthContext | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return verifyToken(header.slice("Bearer ".length).trim());
}
