import { useEffect, useState } from "react";
import { formatFingerprint, safetyNumber } from "@fastmessage/crypto";
import type { DevicePublicKeys } from "@fastmessage/shared";
import { useMessenger } from "../hooks.js";
import { messenger } from "../lib/messaging.js";

export function VerifyModal({
  peerUserId,
  onClose,
}: {
  peerUserId: string;
  onClose: () => void;
}) {
  const state = useMessenger();
  const [devices, setDevices] = useState<DevicePublicKeys[] | null>(null);
  const mySigning = messenger.fingerprint();

  useEffect(() => {
    let alive = true;
    messenger
      .peerDevices(peerUserId)
      .then((d) => alive && setDevices(d))
      .catch(() => alive && setDevices([]));
    return () => {
      alive = false;
    };
  }, [peerUserId]);

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>🛡️ Verify safety numbers</h2>
        <p>
          Compare these out-of-band (in person, or over another trusted channel).
          If they match, no one is intercepting your conversation.
        </p>

        <div className="verify-section">
          <div className="verify-label">Your device</div>
          <code className="fingerprint">{formatFingerprint(mySigning)}</code>
        </div>

        {devices === null && <p className="empty">Loading…</p>}
        {devices?.length === 0 && <p className="empty">No devices found.</p>}
        {devices?.map((d) => {
          const verified = state.verified.includes(d.signingKey);
          return (
            <div key={d.deviceId} className="verify-section">
              <div className="verify-label">
                {d.displayName ?? "Their device"}
                {verified && <span className="verified-badge"> ✓ verified</span>}
              </div>
              <code className="fingerprint">{formatFingerprint(d.signingKey)}</code>
              <div className="safety-number-label">Safety number</div>
              <code className="safety-number">
                {safetyNumber(mySigning, d.signingKey)}
              </code>
              <button
                className={verified ? "tab" : "primary"}
                type="button"
                onClick={() => void messenger.toggleVerified(d.signingKey)}
              >
                {verified ? "Mark unverified" : "Mark verified"}
              </button>
            </div>
          );
        })}

        <div className="modal-actions">
          <button className="tab" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
