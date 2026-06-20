import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  type MailboxResponse,
  SendRequest,
} from "@fastmessage/shared";
import { sendEnvelope } from "../deliver.js";
import { messages } from "../repo.js";
import { authFromRequest } from "../tokens.js";
import { parse } from "../validate.js";

const AckRequest = z.object({ ids: z.array(z.string()).min(1).max(1000) });

export async function messageRoutes(app: FastifyInstance) {
  // REST send (fallback for when the WebSocket is unavailable).
  app.post("/messages", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });

    const body = parse(SendRequest, req.body, reply);
    if (!body) return;

    const results = body.messages.map((m) => ({
      clientMsgId: m.clientMsgId,
      id: sendEnvelope(auth, m).id,
    }));
    return reply.send({ results });
  });

  // Drain undelivered messages for the authenticated device.
  app.get("/messages", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });

    const res: MailboxResponse = {
      messages: messages.listFor(auth.userId, auth.deviceId),
    };
    return reply.send(res);
  });

  // Acknowledge receipt so the server can drop the ciphertext.
  app.post("/messages/ack", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });

    const body = parse(AckRequest, req.body, reply);
    if (!body) return;

    messages.ackDelete(body.ids, auth.userId, auth.deviceId);
    return reply.send({ ok: true });
  });
}
