import { useState } from "react";
import type { AttachmentMeta } from "../lib/files.js";
import { messenger } from "../lib/messaging.js";

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function Attachment({ meta }: { meta: AttachmentMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const isImage = meta.mime.startsWith("image/");

  const load = async () => {
    setBusy(true);
    setError(false);
    try {
      const blob = await messenger.fetchAttachment(meta);
      const objUrl = URL.createObjectURL(blob);
      if (isImage) {
        setUrl(objUrl);
      } else {
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = meta.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  if (isImage && url) {
    return <img className="attach-img" src={url} alt={meta.name} />;
  }
  return (
    <button className="attach" onClick={load} disabled={busy} type="button">
      <span>
        {busy
          ? "Decrypting…"
          : error
            ? "Failed — retry"
            : `${isImage ? "🖼️ View" : "📎 Download"} ${meta.name}`}
      </span>
      <span className="attach-size">{formatSize(meta.size)}</span>
    </button>
  );
}
