import type { FastifyInstance } from "fastify";
import {
  type LockStatusResponse,
  UnlockRequest,
} from "@fastmessage/shared";
import { rateLimit } from "../ratelimit.js";
import { users } from "../repo.js";
import { lockState, unlock } from "../security.js";
import { parse } from "../validate.js";

export async function lockdownRoutes(app: FastifyInstance) {
  // Public status so the UI can explain why sign-in is blocked.
  app.get("/lockdown/status", async (req, reply) => {
    const { username } = req.query as { username?: string };
    if (!username) return reply.code(400).send({ error: "username_required" });
    const user = users.byUsername(username);
    if (!user) {
      const res: LockStatusResponse = { locked: false, level: 0 };
      return reply.send(res); // don't reveal account existence
    }
    const state = lockState(user.id);
    const res: LockStatusResponse = {
      locked: state.level > 0,
      level: state.level,
      retryAfter:
        state.level === 1 && state.lockedUntil
          ? Math.ceil((state.lockedUntil - Date.now()) / 1000)
          : undefined,
    };
    return reply.send(res);
  });

  // Dual-key unlock: requires the user's recovery key AND the admin token.
  app.post(
    "/lockdown/unlock",
    { preHandler: rateLimit({ windowMs: 10 * 60 * 1000, max: 10 }) },
    async (req, reply) => {
      const body = parse(UnlockRequest, req.body, reply);
      if (!body) return;
      const user = users.byUsername(body.username);
      if (!user) return reply.code(400).send({ error: "invalid_keys" });

      const result = unlock(user.id, body.recoveryKey, body.adminToken);
      if (!result.ok) {
        return reply.code(403).send({ error: result.reason ?? "invalid_keys" });
      }
      return reply.send({ ok: true });
    },
  );
}
