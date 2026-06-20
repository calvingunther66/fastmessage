import { hash, verify } from "@node-rs/argon2";
import type { FastifyInstance } from "fastify";
import {
  type AuthResponse,
  type DeviceKeyUpload,
  LoginRequest,
  RegisterRequest,
} from "@fastmessage/shared";
import { devices, oneTimeKeys, users } from "../repo.js";
import { issueToken, authFromRequest, revokeToken } from "../tokens.js";
import { parse } from "../validate.js";

function publishDeviceKeys(userId: string, device: DeviceKeyUpload) {
  devices.upsert({
    userId,
    deviceId: device.deviceId,
    displayName: device.displayName,
    identityKey: device.identityKey,
    signingKey: device.signingKey,
    fallbackKey: device.fallbackKey ?? null,
  });
  if (Object.keys(device.oneTimeKeys).length > 0) {
    oneTimeKeys.add(userId, device.deviceId, device.oneTimeKeys);
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (req, reply) => {
    const body = parse(RegisterRequest, req.body, reply);
    if (!body) return;

    if (users.byUsername(body.username)) {
      return reply.code(409).send({ error: "username_taken" });
    }

    const passwordHash = await hash(body.password);
    const user = users.create(body.username, passwordHash);
    publishDeviceKeys(user.id, body.device);

    const { token, expiresAt } = issueToken(user.id, body.device.deviceId);
    const res: AuthResponse = {
      token,
      userId: user.id,
      deviceId: body.device.deviceId,
      username: user.username,
      expiresAt,
    };
    return reply.code(201).send(res);
  });

  app.post("/auth/login", async (req, reply) => {
    const body = parse(LoginRequest, req.body, reply);
    if (!body) return;

    const user = users.byUsername(body.username);
    // Verify even on missing user to keep timing roughly constant.
    const ok = user
      ? await verify(user.password_hash, body.password).catch(() => false)
      : await hash(body.password).then(() => false);
    if (!user || !ok) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    // The logging-in device (re)publishes its public keys.
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
    // Confirm the caller was actually authenticated (best-effort).
    authFromRequest(req);
    return reply.send({ ok: true });
  });
}
