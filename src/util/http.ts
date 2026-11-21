export function jsonResponse(
  data: unknown,
  init?: ResponseInit,
  csp = defaultCsp()
): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (csp) headers.set("Content-Security-Policy", csp);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function textResponse(
  text: string,
  init?: ResponseInit,
  csp = defaultCsp()
): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  if (csp) headers.set("Content-Security-Policy", csp);
  return new Response(text, { ...init, headers });
}

export function htmlResponse(
  html: string | ReadableStream,
  init?: ResponseInit,
  csp = defaultCsp()
): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  if (csp) headers.set("Content-Security-Policy", csp);
  return new Response(html as any, { ...init, headers });
}

export function defaultCsp(): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
  ].join("; ");
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const parts = header.split(/; */);
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = decodeURIComponent(p.slice(0, eq).trim());
    const v = decodeURIComponent(p.slice(eq + 1).trim());
    if (!(k in out)) out[k] = v;
  }
  return out;
}

export function cookie(
  name: string,
  value: string,
  opts: {
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
    maxAge?: number;
  } = {}
): string {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure !== false) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Strict"}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  return parts.join("; ");
}

