import type { FastifyInstance } from "fastify";
import {
  AddMemberRequest,
  CreateGroupRequest,
  type GroupListResponse,
} from "@fastmessage/shared";
import { groups, users } from "../repo.js";
import { authFromRequest } from "../tokens.js";
import { parse } from "../validate.js";

export async function groupRoutes(app: FastifyInstance) {
  // Create a group (the caller becomes admin) and add the listed members.
  app.post("/groups", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });

    const body = parse(CreateGroupRequest, req.body, reply);
    if (!body) return;

    const group = groups.create(body.name, auth.userId);
    for (const uid of body.memberUserIds) {
      if (uid !== auth.userId && users.byId(uid)) {
        groups.addMember(group.groupId, uid, "member");
      }
    }
    return reply.code(201).send(groups.get(group.groupId));
  });

  // List the groups the caller belongs to.
  app.get("/groups", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });
    const res: GroupListResponse = { groups: groups.listForUser(auth.userId) };
    return reply.send(res);
  });

  // Group detail (members only).
  app.get("/groups/:groupId", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });
    const { groupId } = req.params as { groupId: string };
    if (!groups.isMember(groupId, auth.userId)) {
      return reply.code(403).send({ error: "not_a_member" });
    }
    const g = groups.get(groupId);
    if (!g) return reply.code(404).send({ error: "group_not_found" });
    return reply.send(g);
  });

  // Add a member (any current member may invite).
  app.post("/groups/:groupId/members", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });
    const { groupId } = req.params as { groupId: string };
    if (!groups.isMember(groupId, auth.userId)) {
      return reply.code(403).send({ error: "not_a_member" });
    }
    const body = parse(AddMemberRequest, req.body, reply);
    if (!body) return;
    if (!users.byId(body.userId)) {
      return reply.code(404).send({ error: "user_not_found" });
    }
    groups.addMember(groupId, body.userId, "member");
    return reply.send(groups.get(groupId));
  });

  // Remove a member (or leave the group yourself).
  app.delete("/groups/:groupId/members/:userId", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });
    const { groupId, userId } = req.params as {
      groupId: string;
      userId: string;
    };
    if (!groups.isMember(groupId, auth.userId)) {
      return reply.code(403).send({ error: "not_a_member" });
    }
    groups.removeMember(groupId, userId);
    return reply.send(groups.get(groupId));
  });
}
