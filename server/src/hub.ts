import type { ServerFrame, StoredMessage } from "@fastmessage/shared";

/** A connected client's outbound sink (one per live WebSocket). */
export type Sink = (frame: ServerFrame) => void;

const connections = new Map<string, Set<Sink>>();

const key = (userId: string, deviceId: string) => `${userId}:${deviceId}`;

/**
 * Tracks which devices are connected right now so messages can be pushed
 * instantly. Anything not deliverable live stays in the SQLite mailbox until
 * the device reconnects and drains it.
 */
export const hub = {
  add(userId: string, deviceId: string, sink: Sink): () => void {
    const k = key(userId, deviceId);
    let set = connections.get(k);
    if (!set) {
      set = new Set();
      connections.set(k, set);
    }
    set.add(sink);
    return () => {
      set!.delete(sink);
      if (set!.size === 0) connections.delete(k);
    };
  },

  /** Push a message to every live connection of the recipient device. */
  deliver(toUserId: string, toDeviceId: string, message: StoredMessage): boolean {
    const set = connections.get(key(toUserId, toDeviceId));
    if (!set || set.size === 0) return false;
    for (const sink of set) sink({ t: "message", message });
    return true;
  },

  isOnline(userId: string, deviceId: string): boolean {
    return (connections.get(key(userId, deviceId))?.size ?? 0) > 0;
  },
};
