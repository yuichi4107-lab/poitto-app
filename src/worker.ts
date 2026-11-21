import { Env, TimelineItem } from "./types";
export { Hub } from "./hub";
import { sanitizeFilename, randomId, signCookieValue, verifySignedCookie, timingSafeEqualString } from "./util/crypto";
import { parseCookies, cookie, jsonResponse, htmlResponse, textResponse, defaultCsp } from "./util/http";

const COOKIE_NAME = "sid";
const CSRF_COOKIE = "csrftoken";
const SESSION_MAX_AGE = 60 * 60 * 24 * 400; // 400d

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;
    const MAX_FILE_BYTES = parseInt((env as any).MAX_FILE_BYTES || "2147483648", 10);

    // Static assets and root
    if (method === "GET" && (
      path === "/" ||
      path === "/styles.css" ||
      path === "/app.js" ||
      path.startsWith("/vendor/") ||
      path.startsWith("/assets/") ||
      path === "/manifest.webmanifest" ||
      path === "/sw.js" ||
      path.startsWith("/icons/")
    )) {
      // Let Worker code run first for CSP/auth gating logic if needed, then fetch assets
      const res = await env.ASSETS.fetch(request);
      return withCommonHeaders(res, url.pathname);
    }

    // WebSocket
    if (path === "/ws" && request.headers.get("Upgrade") === "websocket") {
      const stub = env.HUB.get(env.HUB.idFromName("hub"));
      // forward to DO
      const doUrl = new URL("http://do/ws");
      const res = await stub.fetch(doUrl, { headers: request.headers });
      return res;
    }

    // Public share links
    if (path === "/l" || path.startsWith("/l/")) {
      if (method !== "GET") return textResponse("Method Not Allowed", { status: 405 });
      const token = path.split("/")[2] || url.searchParams.get("t") || "";
      if (!token) return htmlResponse(renderShareNotFound(), { status: 404 });
      const resolved = await doCall(env, "do/share/resolve", { token });
      if (!resolved.ok) {
        return htmlResponse(renderShareNotFound(), { status: 404 });
      }
      const item = resolved.item as TimelineItem;
      if (item.kind === "text") {
        return htmlResponse(renderShareText(item));
      } else {
        // Render a minimal download page with a link
        return htmlResponse(renderShareDownload(item, token));
      }
    }
    if (path.startsWith("/api/share/") && path.endsWith("/download") && method === "GET") {
      const token = path.split("/")[3];
      const resolved = await doCall(env, "do/share/resolve", { token });
      if (!resolved.ok) return textResponse("Not found", { status: 404 });
      const item = resolved.item as TimelineItem;
      if (!item.r2Key) return textResponse("Not found", { status: 404 });
      const object = await env.BUCKET.get(item.r2Key);
      if (!object) return textResponse("Not found", { status: 404 });
      const headers = new Headers();
      const filename = item.filename ? sanitizeFilename(item.filename) : "file";
      headers.set(
        "Content-Disposition",
        contentDisposition(filename)
      );
      if (object.httpMetadata?.contentType || item.contentType) {
        headers.set("Content-Type", object.httpMetadata?.contentType ?? item.contentType!);
      }
      return new Response(object.body, { headers });
    }

    // PWA Web Share Target
    if (path === "/share-target" && method === "POST") {
      const auth = await authenticate(request, env);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const contentType = request.headers.get("Content-Type") || "";
      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        const text = form.get("text");
        const files = form.getAll("files") as File[];
        const device = auth.device!;
        const created: string[] = [];
        if (typeof text === "string" && text.trim().length > 0) {
          const item: TimelineItem = {
            id: await randomId(20),
            kind: "text",
            createdAt: Date.now(),
            deviceId: device.id,
            deviceName: device.name,
            text: text.toString(),
          };
          await doCall(env, "do/item/add", item);
          created.push(item.id);
        }
        for (const f of files) {
          if (!(f instanceof File)) continue;
          if (f.size > MAX_FILE_BYTES) {
            return textResponse(`ファイルが上限(${formatBytes(MAX_FILE_BYTES)})を超えています: ${f.name}`, { status: 413 });
          }
          // For Share Target, accept small files directly via put()
          const id = await randomId(20);
          const key = `items/${id}`;
          await env.BUCKET.put(key, await f.arrayBuffer(), {
            httpMetadata: { contentType: f.type || "application/octet-stream" }
          });
          const item: TimelineItem = {
            id,
            kind: "file",
            createdAt: Date.now(),
            deviceId: device.id,
            deviceName: device.name,
            filename: f.name,
            contentType: f.type || "application/octet-stream",
            size: f.size,
            r2Key: key,
          };
          await doCall(env, "do/item/add", item);
          created.push(id);
        }
        return jsonResponse({ ok: true, created });
      }
      return textResponse("Bad Request", { status: 400 });
    }
    if (path === "/api/config" && method === "GET") {
      return jsonResponse({ maxFileBytes: MAX_FILE_BYTES });
    }


    // iOS Shortcuts ingest (token-based)
    if (path === "/api/shortcut/ingest") {
      const token = url.searchParams.get("token") || (await readJson<{ token?: string }>(request))?.token;
      if (!token) return textResponse("Unauthorized", { status: 401 });
      const res = await doCall(env, "do/token/resolve", { token });
      if (!res?.ok) return textResponse("Unauthorized", { status: 401 });
      const device = res.device;
      const text = url.searchParams.get("text") ?? (await readJson<{ text?: string }>(request))?.text;
      if (!text || !text.trim()) return textResponse("Bad Request", { status: 400 });
      const item: TimelineItem = {
        id: await randomId(20),
        kind: "text",
        createdAt: Date.now(),
        deviceId: device.id,
        deviceName: device.name,
        text: text,
      };
      await doCall(env, "do/item/add", item);
      return jsonResponse({ ok: true, id: item.id });
    }

    // Auth-free endpoints for HTML pages
    if (path === "/login" || path === "/setup" || path === "/pair") {
      const res = await env.ASSETS.fetch(new Request(new URL("/", url).toString(), request));
      return withCommonHeaders(res, "/");
    }

    // API
    if (path === "/api/status" && method === "GET") {
      const init = await doCall(env, "do/admin/is_set");
      const auth = await authenticate(request, env);
      return jsonResponse({ initialized: !!init?.initialized, signedIn: !!auth.ok });
    }

    if (path === "/api/setup" && method === "POST") {
      // ADMIN_SETUP_PASSPHRASE must be configured; refuse if missing
      const adminSecretRaw = (env as any).ADMIN_SETUP_PASSPHRASE as string | undefined;
      if (!adminSecretRaw || !adminSecretRaw.trim()) {
        return textResponse("管理者初期パスフレーズが未設定です。Cloudflare ダッシュボードで ADMIN_SETUP_PASSPHRASE を設定してください。", { status: 500 });
      }
      // Allowed only if admin not set
      const init = await doCall(env, "do/admin/is_set");
      if (init?.initialized) {
        return textResponse("Already initialized", { status: 400 });
      }
      const body = await readJson<{ password?: string; deviceName?: string }>(request);
      const typed = ((body?.password ?? "") as string).trim().normalize("NFKC");
      const adminSecret = adminSecretRaw.trim().normalize("NFKC");
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (typed.length === 0) {
        await doCall(env, "do/rate/record", { key: `setup:${ip}` });
        return textResponse("パスフレーズを入力してください", { status: 400 });
      }
      if (!timingSafeEqualString(typed, adminSecret)) {
        const rl = await doCall(env, "do/rate/record", { key: `setup:${ip}` });
        if (rl?.blocked) return textResponse("試行回数が多すぎます。しばらくしてからお試しください。", { status: 429 });
        return textResponse("パスフレーズが違います", { status: 401 });
      }
      const deviceName = (body?.deviceName ?? "My Device").slice(0, 64);
      const r = await doCall(env, "do/admin/set", { password: typed });
      if (!r?.ok) {
        if (r?.error === "already_set") {
          return textResponse("Already initialized", { status: 400 });
        }
        return textResponse(String(r?.error || "セットアップに失敗しました"), { status: r?.status ?? 500 });
      }
      // Register this device via pairing flow and issue session
      const start = await doCall(env, "do/pair/start", {});
      if (!start || !start.token) {
        return textResponse(String(start?.error || "セットアップに失敗しました"), { status: start?.status ?? 500 });
      }
      const claimed = await doCall(env, "do/pair/claim", { token: start.token, deviceName });
      if (!claimed?.ok) {
        if (claimed?.status === 400 || claimed?.error === "invalid_or_expired") {
          return textResponse("セットアップに失敗しました", { status: 500 });
        }
        return textResponse(String(claimed?.error || "セットアップに失敗しました"), { status: claimed?.status ?? 500 });
      }
      const device = claimed.device;
      const sid = claimed.session.token as string;
      const headers = new Headers();
      const signed = await signCookieValue(sid, env.COOKIE_SIGNING_KEY);
      headers.append("Set-Cookie", cookie(COOKIE_NAME, signed, { maxAge: SESSION_MAX_AGE, sameSite: "Lax", secure: true }));
      const csrf = await randomId(18);
      headers.append("Set-Cookie", cookie(CSRF_COOKIE, csrf, { httpOnly: false, maxAge: SESSION_MAX_AGE, sameSite: "Lax", secure: true }));
      return jsonResponse({ ok: true, device }, { headers });
    }

    if (path === "/api/login" && method === "POST") {
      const body = await readJson<{ password?: string; deviceName?: string }>(request);
      if (!body?.password) return textResponse("パスフレーズを入力してください", { status: 400 });
      const v = await doCall(env, "do/admin/verify", { password: body.password });
      if (!v?.ok) {
        if (v?.error) {
          return textResponse(String(v.error), { status: v.status ?? 500 });
        }
        await sleep(700);
        return textResponse("認証に失敗しました", { status: 401 });
      }
      const devName = (body.deviceName ?? "My Device").slice(0, 64);
      const start = await doCall(env, "do/pair/start", {});
      if (!start || !start.token) {
        return textResponse(String(start?.error || "ログインに失敗しました"), { status: start?.status ?? 500 });
      }
      const claimed = await doCall(env, "do/pair/claim", { token: start.token, deviceName: devName });
      if (!claimed?.ok) {
        if (claimed?.status === 400 || claimed?.error === "invalid_or_expired") {
          return textResponse("ログインに失敗しました", { status: 500 });
        }
        return textResponse(String(claimed?.error || "ログインに失敗しました"), { status: claimed?.status ?? 500 });
      }
      const sid = claimed.session.token as string;
      const headers = new Headers();
      const signed = await signCookieValue(sid, env.COOKIE_SIGNING_KEY);
      headers.append("Set-Cookie", cookie(COOKIE_NAME, signed, { maxAge: SESSION_MAX_AGE, sameSite: "Lax", secure: true }));
      const csrf = await randomId(18);
      headers.append("Set-Cookie", cookie(CSRF_COOKIE, csrf, { httpOnly: false, maxAge: SESSION_MAX_AGE, sameSite: "Lax", secure: true }));
      return jsonResponse({ ok: true, device: claimed.device }, { headers });
    }

    if (path === "/api/pair/start" && method === "POST") {
      const auth = await authenticate(request, env);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const r = await doCall(env, "do/pair/start", {});
      if (!r || !r.token) {
        return textResponse(String(r?.error || "ペアリング開始に失敗しました"), { status: r?.status ?? 500 });
      }
      const urlForQr = new URL(url.origin + "/pair");
      urlForQr.searchParams.set("t", r.token);
      return jsonResponse({ pairCode: r.code, pairToken: r.token, pairUrl: urlForQr.toString(), expiresAt: r.expiresAt });
    }
    if (path === "/api/pair/claim" && method === "POST") {
      const body = await readJson<{ token?: string; code?: string; deviceName: string }>(request);
      if (!body?.deviceName) return textResponse("端末名を入力してください", { status: 400 });
      const r = await doCall(env, "do/pair/claim", body);
      if (!r?.ok) {
        if (r?.error === "invalid_or_expired" || r?.status === 400) {
          return textResponse("無効または期限切れのコード", { status: 400 });
        }
        return textResponse(String(r?.error || "ペアリングに失敗しました"), { status: r?.status ?? 500 });
      }
      const sid = r.session.token as string;
      const headers = new Headers();
      const signed = await signCookieValue(sid, env.COOKIE_SIGNING_KEY);
      headers.append("Set-Cookie", cookie(COOKIE_NAME, signed, { maxAge: SESSION_MAX_AGE, sameSite: "Lax", secure: true }));
      const csrf = await randomId(18);
      headers.append("Set-Cookie", cookie(CSRF_COOKIE, csrf, { httpOnly: false, maxAge: SESSION_MAX_AGE, sameSite: "Lax", secure: true }));
      return jsonResponse({ ok: true, device: r.device }, { headers });
    }

    if (path === "/api/session" && method === "GET") {
      const auth = await authenticate(request, env);
      if (!auth.ok) return jsonResponse({ ok: false }, { status: 401 });
      return jsonResponse({ ok: true, device: auth.device, csrf: auth.csrf });
    }
    if (path === "/api/devices" && method === "GET") {
      const auth = await authenticate(request, env);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const r = await doCall(env, "do/devices");
      return jsonResponse(r);
    }
    if (path === "/api/device/token/issue" && method === "POST") {
      const auth = await authenticate(request, env, true);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const { id } = await readJson<{ id: string }>(request) ?? ({} as any);
      if (!id) return textResponse("Bad Request", { status: 400 });
      const r = await doCall(env, "do/device/token/issue", { id });
      return jsonResponse(r, { status: r?.ok ? 200 : 400 });
    }
    if (path === "/api/device/token/get" && method === "POST") {
      const auth = await authenticate(request, env, true);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const { id } = await readJson<{ id: string }>(request) ?? ({} as any);
      if (!id) return textResponse("Bad Request", { status: 400 });
      const r = await doCall(env, "do/device/token/get", { id });
      return jsonResponse(r, { status: r?.ok ? 200 : 404 });
    }
    if (path === "/api/device/token/revoke" && method === "POST") {
      const auth = await authenticate(request, env, true);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const { id } = await readJson<{ id: string }>(request) ?? ({} as any);
      if (!id) return textResponse("Bad Request", { status: 400 });
      const r = await doCall(env, "do/device/token/revoke", { id });
      return jsonResponse(r);
    }
    if (path.startsWith("/api/devices/") && method === "DELETE") {
      const auth = await authenticate(request, env, true);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const id = path.split("/")[3] || path.split("/")[2];
      await doCall(env, "do/device/revoke", { id });
      return jsonResponse({ ok: true });
    }

    if (path === "/api/items" && method === "GET") {
      const auth = await authenticate(request, env);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const r = await doCall(env, "do/items");
      return jsonResponse(r);
    }
    if (path === "/api/items/text" && method === "POST") {
      const auth = await authenticate(request, env, true);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const { text } = (await readJson<{ text: string }>(request)) ?? ({} as { text?: string });
      if (!text || !text.trim()) return textResponse("Bad Request", { status: 400 });
      const item: TimelineItem = {
        id: await randomId(20),
        kind: "text",
        createdAt: Date.now(),
        deviceId: auth.device!.id,
        deviceName: auth.device!.name,
        text,
      };
      await doCall(env, "do/item/add", item);
      return jsonResponse({ ok: true, id: item.id });
    }

    // Multipart upload API
    if (path === "/api/upload/direct" && method === "PUT") {
      const auth = await authenticate(request, env, true);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const filename = url.searchParams.get("filename") || "file";
      const contentType = url.searchParams.get("contentType") || "application/octet-stream";
      const sizeParam = Number(url.searchParams.get("size") || "0");
      const buf = new Uint8Array(await request.arrayBuffer());
      if (buf.byteLength > MAX_FILE_BYTES) {
        return textResponse(`ファイルが上限(${formatBytes(MAX_FILE_BYTES)})を超えています: ${filename}`, { status: 413 });
      }
      const id = await randomId(20);
      const key = `items/${id}`;
      await env.BUCKET.put(key, buf, { httpMetadata: { contentType }});
      const item: TimelineItem = {
        id,
        kind: "file",
        createdAt: Date.now(),
        deviceId: auth.device!.id,
        deviceName: auth.device!.name,
        filename,
        contentType,
        size: buf.byteLength || sizeParam || undefined,
        r2Key: key,
      };
      await doCall(env, "do/item/add", item);
      return jsonResponse({ ok: true, id });
    }
    if (path === "/api/multipart/create" && method === "POST") {
      const auth = await authenticate(request, env, true);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const { filename, contentType, size } = (await readJson<{ filename: string; contentType?: string; size?: number }>(request)) ?? ({} as { filename?: string; contentType?: string; size?: number });
      if (typeof size === "number" && size > MAX_FILE_BYTES) {
        return textResponse(`ファイルが上限(${formatBytes(MAX_FILE_BYTES)})を超えています: ${filename}`, { status: 413 });
      }
      const id = await randomId(20);
      const key = `items/${id}`;
      const contentTypeFinal = contentType || "application/octet-stream";
      const mp = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: contentTypeFinal }});
      return jsonResponse({ uploadId: mp.uploadId, key, itemId: id });
    }
    if (path === "/api/multipart/upload" && method === "PUT") {
      const auth = await authenticate(request, env);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const uploadId = url.searchParams.get("uploadId")!;
      const key = url.searchParams.get("key")!;
      const partNumber = Number(url.searchParams.get("partNumber"));
      if (!uploadId || !key || !Number.isFinite(partNumber)) return textResponse("Bad Request", { status: 400 });
      const buf = await request.arrayBuffer();
      const mp = env.BUCKET.resumeMultipartUpload(key, uploadId);
      const part = await mp.uploadPart(partNumber, buf);
      return jsonResponse({ partNumber: part.partNumber, etag: part.etag });
    }
    if (path === "/api/multipart/complete" && method === "POST") {
      const auth = await authenticate(request, env, true);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const { uploadId, key, parts, itemId, filename, contentType, size } = (await readJson<{
        uploadId: string;
        key: string;
        parts: { partNumber: number; etag: string | { etag?: string } }[];
        itemId: string;
        filename: string;
        contentType?: string;
        size?: number;
      }>(request)) ?? ({} as Partial<{
        uploadId: string;
        key: string;
        parts: { partNumber: number; etag: string | { etag?: string } }[];
        itemId: string;
        filename: string;
        contentType?: string;
        size?: number;
      }>);
      if (typeof size === "number" && size > MAX_FILE_BYTES) {
        return textResponse(`ファイルが上限(${formatBytes(MAX_FILE_BYTES)})を超えています: ${filename}`, { status: 413 });
      }
      if (!uploadId || !key || !itemId || !Array.isArray(parts) || !parts.length) {
        return textResponse("Bad Request: uploadId, key and parts are required", { status: 400 });
      }
      try {
        const mp = env.BUCKET.resumeMultipartUpload(key, uploadId);
        // Accept plain string ETags (current client) and legacy { etag } objects.
        const norm = parts.map((p) => ({
          partNumber: Number(p.partNumber),
          etag: typeof p.etag === "object" && p.etag ? String(p.etag.etag ?? "") : String(p.etag ?? ""),
        }));
        await mp.complete(norm);
      } catch (e: any) {
        return textResponse(`multipart complete failed: ${String(e?.message ?? e)}`, { status: 400 });
      }
      const item: TimelineItem = {
        id: itemId,
        kind: "file",
        createdAt: Date.now(),
        deviceId: auth.device!.id,
        deviceName: auth.device!.name,
        filename,
        contentType: contentType || "application/octet-stream",
        size,
        r2Key: key,
      };
      await doCall(env, "do/item/add", item);
      return jsonResponse({ ok: true, id: itemId });
    }

    if (path.startsWith("/api/items/") && path.endsWith("/download") && method === "GET") {
      const auth = await authenticate(request, env);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const id = path.split("/")[3] || path.split("/")[2];
      const it = (await doCall(env, "do/items")).items.find((x: TimelineItem) => x.id === id) as TimelineItem | undefined;
      if (!it || !it.r2Key) return textResponse("Not found", { status: 404 });
      const obj = await env.BUCKET.get(it.r2Key);
      if (!obj) return textResponse("Not found", { status: 404 });
      const headers = new Headers();
      const filename = it.filename ? sanitizeFilename(it.filename) : "file";
      const inline = url.searchParams.get("inline") === "1";
      headers.set("Content-Disposition", inline ? `inline; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}` : contentDisposition(filename));
      headers.set("Content-Type", obj.httpMetadata?.contentType ?? it.contentType ?? "application/octet-stream");
      return new Response(obj.body, { headers });
    }

    if (path.startsWith("/api/items/") && method === "DELETE") {
      const auth = await authenticate(request, env, true);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const id = path.split("/")[3] || path.split("/")[2];
      const items = (await doCall(env, "do/items")).items as TimelineItem[];
      const it = items.find((x) => x.id === id);
      if (it?.r2Key) await env.BUCKET.delete(it.r2Key);
      await doCall(env, "do/item/delete", { id });
      return jsonResponse({ ok: true });
    }

    if (path.startsWith("/api/items/") && path.endsWith("/share") && method === "POST") {
      const auth = await authenticate(request, env, true);
      if (!auth.ok) return textResponse("Unauthorized", { status: 401 });
      const id = path.split("/")[3] || path.split("/")[2];
      const r = await doCall(env, "do/share/create", { id, retentionHours: env.RETENTION_HOURS });
      if (!r.ok) return textResponse("Not found", { status: 404 });
      const link = new URL(url.origin + "/l/" + r.token);
      return jsonResponse({ ok: true, url: link.toString(), expiresAt: r.expiresAt });
    }

    // Fallback to assets (single-page app)
    const res = await env.ASSETS.fetch(new Request(new URL("/", url).toString(), request));
    return withCommonHeaders(res, "/");
  },

  async scheduled(controller, env, ctx) {
    // Sweep expired items in the DO. Their R2 keys are queued in the DO ("r2:pending")
    // and only dropped from the queue after the R2 delete succeeded (do/cleanup/ack),
    // so a failed delete is retried on the next run.
    const r = await doCall(env, "do/cleanup", { retentionHours: env.RETENTION_HOURS });
    const keys: string[] = Array.isArray(r?.r2Keys)
      ? r.r2Keys.filter((k: unknown): k is string => typeof k === "string" && k.startsWith("items/"))
      : [];
    let deleted = 0;
    let failed = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      try {
        await env.BUCKET.delete(batch);
        const ack = await doCall(env, "do/cleanup/ack", { keys: batch });
        if (!ack?.ok) console.error("cron cleanup ack failed", ack?.error);
        deleted += batch.length;
      } catch (e: any) {
        failed += batch.length;
        console.error("cron cleanup R2 delete failed; will retry next run", String(e?.message ?? e));
      }
    }
    console.log("cron cleanup", { removedRecords: r?.removed ?? 0, r2Deleted: deleted, r2Failed: failed });
  },
} satisfies ExportedHandler<Env>;

function withCommonHeaders(res: Response, path: string): Response {
  const headers = new Headers(res.headers);
  headers.set("Content-Security-Policy", defaultCsp());
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  const ct = (headers.get("Content-Type") || "").toLowerCase();
  if (ct.startsWith("text/html")) {
    if (path.endsWith(".js")) headers.set("Content-Type", "application/javascript; charset=utf-8");
    else if (path.endsWith(".css")) headers.set("Content-Type", "text/css; charset=utf-8");
    else if (path.endsWith(".webmanifest") || path.endsWith(".manifest")) headers.set("Content-Type", "application/manifest+json; charset=utf-8");
  }
  return new Response(res.body, { status: res.status, headers });
}

async function doCall(env: Env, path: string, body?: unknown): Promise<any> {
  const stub = env.HUB.get(env.HUB.idFromName("hub"));
  const url = new URL("http://do/" + path);
  const res = await stub.fetch(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: text || res.statusText, status: res.status };
  }
}

async function authenticate(request: Request, env: Env, checkCsrf = false): Promise<{ ok: boolean; device?: any; csrf?: string }> {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const sidSigned = cookies[COOKIE_NAME];
  if (!sidSigned) return { ok: false };
  const sid = await verifySignedCookie(sidSigned, env.COOKIE_SIGNING_KEY);
  if (!sid) return { ok: false };
  const v = await doCall(env, "do/session/validate", { token: sid });
  if (!v?.ok) return { ok: false };
  if (checkCsrf) {
    const csrfCookie = cookies[CSRF_COOKIE];
    const csrfHeader = request.headers.get("X-CSRF-Token") || request.headers.get("x-csrf-token");
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) return { ok: false };
  }
  return { ok: true, device: v.device, csrf: cookies[CSRF_COOKIE] };
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    if (!request.headers.get("Content-Type")?.includes("application/json")) return null;
    return (await request.json()) as any;
  } catch {
    return null;
  }
}

function escapeHtmlText(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

function renderSharePage(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escapeHtmlText(heading)} - ポイッと</title>
<style>
body{font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;line-height:1.6}
.brand{font-weight:700;opacity:.7;margin-bottom:8px}
.card{border:1px solid rgba(127,127,127,.35);border-radius:12px;padding:16px}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font-family:inherit}
.meta{opacity:.7;font-size:14px}
a.button{display:inline-block;margin-top:12px;padding:10px 16px;border-radius:8px;background:#3b82f6;color:#fff;text-decoration:none}
</style>
</head>
<body>
<div class="brand">ポイッと</div>
<h1>${escapeHtmlText(heading)}</h1>
${bodyHtml}
</body>
</html>`;
}

function renderShareNotFound(): string {
  return renderSharePage(
    "リンクが見つかりません",
    `<div class="card"><p>この受け取りリンクは無効か、有効期限（24時間）が切れています。</p><p class="meta">送った人に新しいリンクを頼んでください。</p></div>`
  );
}

function renderShareText(item: TimelineItem): string {
  return renderSharePage(
    "テキストを受け取りました",
    `<div class="card"><pre>${escapeHtmlText(item?.text ?? "")}</pre></div><p class="meta">このリンクは作成から24時間で無効になります。</p>`
  );
}

function renderShareDownload(item: TimelineItem, token: string): string {
  const name = item?.filename ? sanitizeFilename(item.filename) : "file";
  const size = typeof item?.size === "number" ? formatBytes(item.size) : "";
  const href = `/api/share/${encodeURIComponent(String(token ?? ""))}/download`;
  return renderSharePage(
    "ファイルを受け取る",
    `<div class="card"><div><strong>${escapeHtmlText(name)}</strong></div>${size ? `<div class="meta">${escapeHtmlText(size)}</div>` : ""}<a class="button" href="${escapeHtmlText(href)}" download="${escapeHtmlText(name)}" rel="noopener">ダウンロード</a></div><p class="meta">このリンクは作成から24時間で無効になります。</p>`
  );
}

function contentDisposition(filename: string): string {
  const encoded = encodeRFC5987ValueChars(filename);
  return `attachment; filename*=UTF-8''${encoded}`;
}

function encodeRFC5987ValueChars(str: string): string {
  return encodeURIComponent(str)
    .replace(/['()]/g, escape) // i.e., %27 %28 %29
    .replace(/\*/g, "%2A")
    .replace(/%(7C|60|5E)/g, "%25$1");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(n: number): string {
  const units = ["B","KB","MB","GB","TB"];
  let u = 0;
  let x = n;
  while (x >= 1024 && u < units.length-1) { x /= 1024; u++; }
  return `${x.toFixed(1)} ${units[u]}`;
}

