import type { DeviceKeyUpload } from "@fastmessage/shared";
import { devices, oneTimeKeys } from "./repo.js";

/** Store a device's public keys (used by register, login and device linking). */
export function publishDeviceKeys(userId: string, device: DeviceKeyUpload) {
  devices.upsert({
    userId,
    deviceId: device.deviceId,
    displayName: device.displayName,
    identityKey: device.identityKey,
    signingKey: device.signingKey,
    fallbackKey: device.fallbackKey ?? null,
  });
  if (Object.keys(device.oneTimeKeys).length > 0) {
    oneTimeKeys.add(userId, device.deviceId, device.oneTimeKeys);
  }
}
