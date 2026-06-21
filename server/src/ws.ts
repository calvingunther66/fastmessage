import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ClientFrame,
  type ServerFrame,
  WS_PATH,
} from "@fastmessage/shared";
import { sendEnvelope } from "./deliver.js";
import { hub, type Sink } from "./hub.js";
import { devices, messages } from "./repo.js";
import { verifyToken } from "./tokens.js";

export function registerWebSocket(app: FastifyInstance) {
  // @fastify/websocket v11 passes the raw socket directly to the handler.
  app.get(WS_PATH, { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const send = (frame: ServerFrame) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };

    const token = (req.query as { token?: string }).token ?? "";
    const auth = verifyToken(token);
    if (!auth) {
      send({ t: "error", code: "unauthorized" });
      socket.close(4401, "unauthorized");
      return;
    }

    const sink: Sink = (frame) => send(frame);
    const unregister = hub.add(auth.userId, auth.deviceId, sink);
    devices.touch(auth.userId, auth.deviceId);

    send({ t: "ready", userId: auth.userId, deviceId: auth.deviceId });

    // Drain anything queued while this device was offline. Kept until acked.
    for (const message of messages.listFor(auth.userId, auth.deviceId)) {
      send({ t: "message", message });
    }

    socket.on("message", (raw: Buffer | string) => {
      let frame: ClientFrame;
      try {
        frame = ClientFrame.parse(JSON.parse(raw.toString()));
      } catch {
        send({ t: "error", code: "bad_frame" });
        return;
      }

      switch (frame.t) {
        case "ping":
          send({ t: "pong" });
          break;
        case "send": {
          const stored = sendEnvelope(auth, frame.message);
          send({ t: "sent", clientMsgId: frame.message.clientMsgId, id: stored.id });
          break;
        }
        case "ack":
          messages.ackDelete(frame.ids, auth.userId, auth.deviceId);
          break;
      }
    });

    socket.on("close", () => {
      unregister();
      devices.touch(auth.userId, auth.deviceId);
    });
  });
}
