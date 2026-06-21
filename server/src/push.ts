import webpush from "web-push";
import { config } from "./config.js";
import { pushSubs } from "./repo.js";

let configured = false;
if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    config.VAPID_SUBJECT,
    config.VAPID_PUBLIC_KEY,
    config.VAPID_PRIVATE_KEY,
  );
  configured = true;
}

export function pushEnabled(): boolean {
  return configured;
}

/**
 * Send a content-free wake notification to every push subscription of a device.
 * The payload never contains message content — only "you have a message" — so a
 * push provider learns nothing it shouldn't.
 */
export async function notifyDevice(userId: string, deviceId: string): Promise<void> {
  if (!configured) return;
  const subs = pushSubs.listForDevice(userId, deviceId);
  const payload = JSON.stringify({ title: "FastMessage", body: "New encrypted message" });
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) pushSubs.delete(s.endpoint); // gone
      }
    }),
  );
}
