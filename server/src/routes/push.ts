import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PushSubscribeRequest, type VapidResponse } from "@fastmessage/shared";
import { config } from "../config.js";
import { pushSubs } from "../repo.js";
import { authFromRequest } from "../tokens.js";
import { parse } from "../validate.js";

const UnsubscribeRequest = z.object({ endpoint: z.string() });

export async function pushRoutes(app: FastifyInstance) {
  // Public VAPID key so clients can subscribe (empty if push isn't configured).
  app.get("/push/vapid", async (_req, reply) => {
    const res: VapidResponse = { publicKey: config.VAPID_PUBLIC_KEY };
    return reply.send(res);
  });

  app.post("/push/subscribe", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });
    const body = parse(PushSubscribeRequest, req.body, reply);
    if (!body) return;
    pushSubs.add(auth.userId, auth.deviceId, {
      endpoint: body.subscription.endpoint,
      p256dh: body.subscription.keys.p256dh,
      auth: body.subscription.keys.auth,
    });
    return reply.send({ ok: true });
  });

  app.post("/push/unsubscribe", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });
    const body = parse(UnsubscribeRequest, req.body, reply);
    if (!body) return;
    pushSubs.delete(body.endpoint);
    return reply.send({ ok: true });
  });
}
