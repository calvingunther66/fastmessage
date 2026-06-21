import type { FastifyInstance } from "fastify";
import {
  type AuthResponse,
  LinkClaimRequest,
  type LinkStartResponse,
} from "@fastmessage/shared";
import { consumeLink, createLink } from "../links.js";
import { publishDeviceKeys } from "../publish.js";
import { rateLimit } from "../ratelimit.js";
import { users } from "../repo.js";
import { issueToken, authFromRequest } from "../tokens.js";
import { parse } from "../validate.js";

export async function deviceRoutes(app: FastifyInstance) {
  // A signed-in device mints a one-time link code (shown as a QR).
  app.post("/devices/link/start", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });
    const { code, expiresAt } = createLink(auth.userId);
    const res: LinkStartResponse = { code, expiresAt };
    return reply.send(res);
  });

  // A new device redeems the code to join the account (no password needed).
  app.post(
    "/devices/link/claim",
    { preHandler: rateLimit({ windowMs: 5 * 60 * 1000, max: 20 }) },
    async (req, reply) => {
      const body = parse(LinkClaimRequest, req.body, reply);
      if (!body) return;
      const userId = consumeLink(body.code);
      if (!userId) {
        return reply.code(400).send({ error: "invalid_or_expired_code" });
      }
      const user = users.byId(userId);
      if (!user) return reply.code(400).send({ error: "invalid_or_expired_code" });

      publishDeviceKeys(userId, body.device);
      const { token, expiresAt } = issueToken(userId, body.device.deviceId);
      const res: AuthResponse = {
        token,
        userId,
        deviceId: body.device.deviceId,
        username: user.username,
        expiresAt,
      };
      return reply.send(res);
    },
  );
}
