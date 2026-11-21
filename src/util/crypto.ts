export async function randomBytes(size: number): Promise<Uint8Array> {
  const b = new Uint8Array(size);
  crypto.getRandomValues(b);
  return b;
}

export async function randomId(length = 16): Promise<string> {
  // url-safe base64 without padding
  const b = await randomBytes(length);
  const s = btoa(String.fromCharCode(...b));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function pbkdf2Sha256(
  password: string,
  salt: Uint8Array,
  iterations = 100_000,
  length = 32
): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    keyMaterial,
    length * 8
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = await randomBytes(16);
  const iterations = 100_000;
  const hash = await pbkdf2Sha256(password, salt, iterations, 32);
  return `pbkdf2:sha256:${iterations}:${toHex(salt)}:${toHex(hash)}`;
}

export async function verifyPassword(
  password: string,
  encoded: string
): Promise<boolean> {
  const parts = encoded.split(":");
  if (parts.length !== 5) return false;
  const [, algo, iterStr, saltHex, hashHex] = parts;
  if (algo !== "sha256") return false;
  const iterations = parseInt(iterStr, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const salt = fromHex(saltHex);
  const expected = fromHex(hashHex);
  const derived = new Uint8Array(await pbkdf2Sha256(password, salt, iterations, expected.length));
  return timingSafeEqual(derived, expected);
}

export async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return crypto.subtle.sign("HMAC", key, data);
}

export async function signCookieValue(
  value: string,
  secretHex: string
): Promise<string> {
  const enc = new TextEncoder();
  const mac = await hmacSha256(fromHexOrUtf8(secretHex), enc.encode(value));
  const sig = toHex(mac);
  return `${value}.${sig}`;
}

export async function verifySignedCookie(
  signed: string,
  secretHex: string
): Promise<string | null> {
  const idx = signed.lastIndexOf(".");
  if (idx <= 0) return null;
  const value = signed.slice(0, idx);
  const sigHex = signed.slice(idx + 1);
  const enc = new TextEncoder();
  const mac = await hmacSha256(fromHexOrUtf8(secretHex), enc.encode(value));
  const good = toHex(mac);
  if (timingSafeEqual(fromHex(sigHex), fromHex(good))) return value;
  return null;
}

function fromHexOrUtf8(s: string): Uint8Array {
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) return fromHex(s);
  return new TextEncoder().encode(s);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  return timingSafeEqual(ba, bb);
}

export function sanitizeFilename(name: string): string {
  // Remove path separators and control characters
  let out = name.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").trim();
  if (out.length === 0) out = "file";
  if (out.length > 180) out = out.slice(0, 180);
  return out;
}

