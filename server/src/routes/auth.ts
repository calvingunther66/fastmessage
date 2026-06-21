import { hash, verify } from "@node-rs/argon2";
import type { FastifyInstance } from "fastify";
import { LoginRequest, RegisterRequest, type AuthResponse } from "@fastmessage/shared";
import { publishDeviceKeys } from "../publish.js";
import { rateLimit } from "../ratelimit.js";
import { users } from "../repo.js";
import {
  lockState,
  provisionAccount,
  recordFailure,
  recordSuccess,
  registerTamper,
} from "../security.js";
import { issueToken, authFromRequest, revokeToken } from "../tokens.js";
import { parse } from "../validate.js";

export async function authRoutes(app: FastifyInstance) {
  const limiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 30 });

  app.post("/auth/register", { preHandler: limiter }, async (req, reply) => {
    const body = parse(RegisterRequest, req.body, reply);
    if (!body) return;

    if (users.byUsername(body.username)) {
      return reply.code(409).send({ error: "username_taken" });
    }

    const passwordHash = await hash(body.password);
    const user = users.create(body.username, passwordHash);
    const recoveryKey = provisionAccount(user.id);
    publishDeviceKeys(user.id, body.device);

    const { token, expiresAt } = issueToken(user.id, body.device.deviceId);
    const res: AuthResponse = {
      token,
      userId: user.id,
      deviceId: body.device.deviceId,
      username: user.username,
      expiresAt,
      recoveryKey,
    };
    return reply.code(201).send(res);
  });

  app.post("/auth/login", { preHandler: limiter }, async (req, reply) => {
    const body = parse(LoginRequest, req.body, reply);
    if (!body) return;

    const user = users.byUsername(body.username);
    // Don't reveal whether the username exists; still spend time hashing.
    if (!user) {
      await hash(body.password).catch(() => undefined);
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    // Refuse before checking the password if the account is locked.
    const state = lockState(user.id);
    if (state.level === 2) {
      registerTamper(user.id);
      return reply.code(423).send({ error: "account_locked" });
    }
    if (state.level === 1) {
      registerTamper(user.id);
      const retryAfter = Math.ceil(((state.lockedUntil ?? Date.now()) - Date.now()) / 1000);
      return reply.code(429).send({ error: "temporarily_locked", retryAfter });
    }

    const ok = await verify(user.password_hash, body.password).catch(() => false);
    if (!ok) {
      const next = recordFailure(user.id);
      if (next.level === 2) return reply.code(423).send({ error: "account_locked" });
      if (next.level === 1) {
        const retryAfter = Math.ceil(((next.lockedUntil ?? Date.now()) - Date.now()) / 1000);
        return reply.code(429).send({ error: "temporarily_locked", retryAfter });
      }
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    recordSuccess(user.id);
    publishDeviceKeys(user.id, body.device);

    const { token, expiresAt } = issueToken(user.id, body.device.deviceId);
    const res: AuthResponse = {
      token,
      userId: user.id,
      deviceId: body.device.deviceId,
      username: user.username,
      expiresAt,
    };
    return reply.send(res);
  });

  app.post("/auth/logout", async (req, reply) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      revokeToken(header.slice("Bearer ".length).trim());
    }
    authFromRequest(req);
    return reply.send({ ok: true });
  });
}
