import type { FastifyInstance } from "fastify";
import {
  type ClaimedBundle,
  ClaimRequest,
  type DeviceListResponse,
  ReplenishRequest,
  type UserLookupResponse,
} from "@fastmessage/shared";
import { devices, oneTimeKeys, users } from "../repo.js";
import { authFromRequest } from "../tokens.js";
import { parse } from "../validate.js";

export async function keyRoutes(app: FastifyInstance) {
  // Claim a prekey bundle for each target device (consumes a one-time key).
  app.post("/keys/claim", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });

    const body = parse(ClaimRequest, req.body, reply);
    if (!body) return;

    const bundles: ClaimedBundle[] = [];
    for (const target of body.targets) {
      const device = devices.get(target.userId, target.deviceId);
      if (!device) continue;

      let oneTimeKey = oneTimeKeys.claim(target.userId, target.deviceId);
      if (!oneTimeKey && device.fallback_key_id && device.fallback_key) {
        // Fall back to the reusable last-resort key.
        oneTimeKey = { keyId: device.fallback_key_id, key: device.fallback_key };
      }
      bundles.push({
        userId: target.userId,
        deviceId: target.deviceId,
        identityKey: device.identity_key,
        signingKey: device.signing_key,
        oneTimeKey,
      });
    }
    return reply.send({ bundles });
  });

  // Top up one-time keys (and optionally rotate the fallback) for this device.
  app.post("/keys/replenish", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });

    const body = parse(ReplenishRequest, req.body, reply);
    if (!body) return;

    if (Object.keys(body.oneTimeKeys).length > 0) {
      oneTimeKeys.add(auth.userId, auth.deviceId, body.oneTimeKeys);
    }
    if (body.fallbackKey) {
      devices.setFallback(auth.userId, auth.deviceId, body.fallbackKey);
    }
    const remaining = oneTimeKeys.countUnclaimed(auth.userId, auth.deviceId);
    return reply.send({ ok: true, remaining });
  });

  // List a user's devices (public keys) for fan-out + verification.
  app.get("/devices/:userId", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });

    const { userId } = req.params as { userId: string };
    if (!users.byId(userId)) {
      return reply.code(404).send({ error: "user_not_found" });
    }
    const res: DeviceListResponse = { userId, devices: devices.list(userId) };
    return reply.send(res);
  });

  // Resolve a username to a user id to start a conversation.
  app.get("/users/lookup", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });

    const { username } = req.query as { username?: string };
    if (!username) return reply.code(400).send({ error: "username_required" });

    const user = users.byUsername(username);
    if (!user) return reply.code(404).send({ error: "user_not_found" });
    const res: UserLookupResponse = {
      userId: user.id,
      username: user.username,
    };
    return reply.send(res);
  });

  // Resolve a user id back to a username (e.g. for an incoming message).
  app.get("/users/:userId", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });

    const { userId } = req.params as { userId: string };
    const user = users.byId(userId);
    if (!user) return reply.code(404).send({ error: "user_not_found" });
    const res: UserLookupResponse = { userId: user.id, username: user.username };
    return reply.send(res);
  });
}
