/**
 * Client-side attachment encryption. Files are encrypted with a fresh
 * AES-256-GCM key before upload; only the ciphertext is sent to the server. The
 * key + iv travel inside the E2E-encrypted message, so the server can never
 * decrypt an attachment.
 */

export interface AttachmentMeta {
  name: string;
  mime: string;
  size: number;
  blobId: string;
  key: string; // base64 AES key
  iv: string; // base64 GCM iv
  hash: string; // base64 SHA-256 of the ciphertext
}

export interface EncryptedFile {
  ciphertext: Uint8Array<ArrayBuffer>;
  key: string;
  iv: string;
  hash: string;
  name: string;
  mime: string;
  size: number;
}

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptFile(file: File): Promise<EncryptedFile> {
  const data = new Uint8Array(await file.arrayBuffer());
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data),
  );
  const rawKey = await crypto.subtle.exportKey("raw", key);
  const hash = await crypto.subtle.digest("SHA-256", ct);
  return {
    ciphertext: ct,
    key: toB64(rawKey),
    iv: toB64(iv),
    hash: toB64(hash),
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
  };
}

export async function decryptToBlob(
  ciphertext: Uint8Array<ArrayBuffer>,
  keyB64: string,
  ivB64: string,
  mime: string,
): Promise<Blob> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromB64(keyB64),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(ivB64) },
    key,
    ciphertext,
  );
  return new Blob([plaintext], { type: mime });
}
