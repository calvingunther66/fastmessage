import type { OutgoingEnvelope, StoredMessage } from "@fastmessage/shared";
import { hub } from "./hub.js";
import { notifyDevice } from "./push.js";
import { messages } from "./repo.js";
import type { AuthContext } from "./tokens.js";

/**
 * Persist an encrypted envelope to the recipient's mailbox and push it to any
 * live connection. The mailbox row holds ciphertext only; it is removed once
 * the recipient device acks. Used by both the WebSocket gateway and REST.
 */
export function sendEnvelope(
  from: AuthContext,
  out: OutgoingEnvelope,
): StoredMessage {
  const stored = messages.enqueue({
    toUserId: out.toUserId,
    toDeviceId: out.toDeviceId,
    fromUserId: from.userId,
    fromDeviceId: from.deviceId,
    envelope: out.envelope,
    sentAt: Date.now(),
  });
  const live = hub.deliver(out.toUserId, out.toDeviceId, stored);
  // If the device isn't connected, wake it with a content-free push.
  if (!live) void notifyDevice(out.toUserId, out.toDeviceId);
  return stored;
}
