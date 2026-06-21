import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { messenger } from "../lib/messaging.js";

export function LinkModal({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    messenger
      .startDeviceLink()
      .then(async ({ code }) => {
        if (!alive) return;
        setCode(code);
        const url = `${location.origin}/?link=${encodeURIComponent(code)}`;
        setQr(await QRCode.toDataURL(url, { margin: 1, width: 220 }));
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>🔗 Link a device</h2>
        <p>
          On your other device, scan this QR with its camera — or enter the code
          on the sign-in screen. It expires in ~2 minutes and works once.
        </p>
        {error && <div className="error">Couldn't create a link code.</div>}
        {qr && <img className="link-qr" src={qr} alt="Device link QR code" />}
        {code && <code className="recovery-key">{code}</code>}
        <div className="modal-actions">
          <button className="tab" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
