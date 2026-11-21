import { randomId, hashPassword, verifyPassword } from "./util/crypto";
import type { TimelineItem, DeviceInfo } from "./types";

type StoredSession = {
  deviceId: string;
  createdAt: number;
  expiresAt: number;
};

type PairRecord = {
  token: string;
  code: string;
  createdAt: number;
  expiresAt: number;
  used?: boolean;
};

type ShareRecord = {
  itemId: string;
  createdAt: number;
  expiresAt: number;
};

export class Hub implements DurableObject {
  private state: DurableObjectState;
  private sockets: Set<WebSocket> = new Set();
  private ttlMs = 1000 * 60 * 60 * 24 * 180; // 180 days for sessions
  private RATE_LIMIT_MAX = 5;
  private RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      // no-op for now
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");
    try {
      if (path === "ws") {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("Expected WebSocket", { status: 426 });
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        this.state.acceptWebSocket(server);
        this.sockets.add(server);
        server.addEventListener("close", () => this.sockets.delete(server));
        return new Response(null, { status: 101, webSocket: client });
      }
      if (path === "do/admin/set" && request.method === "POST") {
        const body = await request.json<{ password: string }>();
        const exists = await this.state.storage.get<string>("admin:pass");
        if (exists) return json({ ok: false, error: "already_set" }, 400);
        const hashed = await hashPassword(body.password);
        await this.state.storage.put("admin:pass", hashed);
        await this.broadcast({ type: "admin_set" });
        return json({ ok: true });
      }
      if (path === "do/admin/is_set" && request.method === "GET") {
        const exists = await this.state.storage.get<string>("admin:pass");
        return json({ initialized: !!exists });
      }
      if (path === "do/admin/verify" && request.method === "POST") {
        const body = await request.json<{ password: string }>();
        const hashed = await this.state.storage.get<string>("admin:pass");
        if (!hashed) return json({ ok: false, error: "not_set" }, 400);
        const good = await verifyPassword(body.password, hashed);
        return json({ ok: good });
      }
      if (path === "do/pair/start" && request.method === "POST") {
        const now = Date.now();
        const token = await randomId(24);
        const code = (Math.floor(Math.random() * 1_000_000) + "")
          .padStart(6, "0");
        const rec: PairRecord = {
          token,
          code,
          createdAt: now,
          expiresAt: now + 1000 * 60 * 5, // 5 minutes
        };
        await this.state.storage.put(`pair:token:${token}`, rec);
        await this.state.storage.put(`pair:code:${code}`, rec);
        return json({ token, code, expiresAt: rec.expiresAt });
      }
      if (path === "do/pair/claim" && request.method === "POST") {
        const body = await request.json<{ token?: string; code?: string; deviceName: string }>();
        const rec = body.token
          ? await this.state.storage.get<PairRecord>(`pair:token:${body.token}`)
          : body.code
          ? await this.state.storage.get<PairRecord>(`pair:code:${body.code}`)
          : null;
        if (!rec || rec.used || rec.expiresAt < Date.now()) {
          return json({ ok: false, error: "invalid_or_expired" }, 400);
        }
        // Mark used
        rec.used = true;
        await this.state.storage.put(`pair:token:${rec.token}`, rec);
        await this.state.storage.put(`pair:code:${rec.code}`, rec);
        // Create device
        const deviceId = await randomId(18);
        const device: DeviceInfo = {
          id: deviceId,
          name: body.deviceName,
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
        };
        await this.state.storage.put(`dev:${deviceId}`, device);
        await this.appendIndex("devices:index", deviceId);
        const session = await this.createSession(deviceId);
        await this.broadcast({ type: "devices_changed" });
        return json({ ok: true, device, session });
      }
      if (path === "do/devices" && request.method === "GET") {
        const ids = await this.getIndex("devices:index");
        const devices: DeviceInfo[] = [];
        for (const id of ids) {
          const d = await this.state.storage.get<DeviceInfo>(`dev:${id}`);
          if (d && !d.revoked) devices.push(d);
        }
        return json({ devices });
      }
      if (path === "do/device/token/issue" && request.method === "POST") {
        const { id } = await request.json<{ id: string }>();
        const d = await this.state.storage.get<DeviceInfo>(`dev:${id}`);
        if (!d || d.revoked) return json({ ok: false, error: "not_found" }, 404);
        // Revoke existing token if any
        if (d.apiToken) {
          await this.state.storage.delete(`token:${d.apiToken}`);
        }
        const token = await randomId(28);
        d.apiToken = token;
        await this.state.storage.put(`dev:${id}`, d);
        await this.state.storage.put(`token:${token}`, { deviceId: id, createdAt: Date.now() });
        return json({ ok: true, token });
      }
      if (path === "do/device/token/get" && request.method === "POST") {
        const { id } = await request.json<{ id: string }>();
        const d = await this.state.storage.get<DeviceInfo>(`dev:${id}`);
        if (!d || d.revoked) return json({ ok: false, error: "not_found" }, 404);
        return json({ ok: true, token: d.apiToken ?? null });
      }
      if (path === "do/device/token/revoke" && request.method === "POST") {
        const { id } = await request.json<{ id: string }>();
        const d = await this.state.storage.get<DeviceInfo>(`dev:${id}`);
        if (!d || d.revoked) return json({ ok: true }); // already gone
        if (d.apiToken) {
          await this.state.storage.delete(`token:${d.apiToken}`);
          delete d.apiToken;
          await this.state.storage.put(`dev:${id}`, d);
        }
        return json({ ok: true });
      }
      if (path === "do/token/resolve" && request.method === "POST") {
        const { token } = await request.json<{ token: string }>();
        const rec = await this.state.storage.get<{ deviceId: string }>(`token:${token}`);
        if (!rec) return json({ ok: false }, 404);
        const d = await this.state.storage.get<DeviceInfo>(`dev:${rec.deviceId}`);
        if (!d || d.revoked) return json({ ok: false }, 404);
        return json({ ok: true, device: d });
      }
      if (path === "do/device/revoke" && request.method === "POST") {
        const { id } = await request.json<{ id: string }>();
        const d = await this.state.storage.get<DeviceInfo>(`dev:${id}`);
        if (d) {
          d.revoked = true;
          await this.state.storage.put(`dev:${id}`, d);
          await this.broadcast({ type: "devices_changed" });
        }
        return json({ ok: true });
      }
      if (path === "do/session/create" && request.method === "POST") {
        const { deviceId } = await request.json<{ deviceId: string }>();
        const session = await this.createSession(deviceId);
        return json({ session });
      }
      if (path === "do/session/validate" && request.method === "POST") {
        const { token } = await request.json<{ token: string }>();
        const rec = await this.state.storage.get<StoredSession>(`sess:${token}`);
        if (!rec || rec.expiresAt < Date.now()) {
          return json({ ok: false });
        }
        const device = await this.state.storage.get<DeviceInfo>(`dev:${rec.deviceId}`);
        if (!device || device.revoked) return json({ ok: false });
        device.lastSeenAt = Date.now();
        await this.state.storage.put(`dev:${device.id}`, device);
        return json({ ok: true, device });
      }
      if (path === "do/item/add" && request.method === "POST") {
        const item = await request.json<TimelineItem>();
        await this.state.storage.put(`item:${item.id}`, item);
        await this.appendIndex("items:index", item.id);
        await this.broadcast({ type: "items_changed" });
        return json({ ok: true });
      }
      if (path === "do/item/delete" && request.method === "POST") {
        const { id } = await request.json<{ id: string }>();
        await this.state.storage.delete(`item:${id}`);
        await this.removeFromIndex("items:index", id);
        await this.broadcast({ type: "items_changed" });
        return json({ ok: true });
      }
      if (path === "do/items" && request.method === "GET") {
        const offset = parseInt(url.searchParams.get("offset") || "0", 10) || 0;
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
        const ids = await this.getIndex("items:index");
        const items: TimelineItem[] = [];
        for (const id of ids) {
          const it = await this.state.storage.get<TimelineItem>(`item:${id}`);
          if (it) items.push(it);
        }
        items.sort((a, b) => b.createdAt - a.createdAt);
        const sliced = items.slice(offset, offset + limit);
        const nextOffset = offset + sliced.length < items.length ? offset + sliced.length : null;
        return json({ items: sliced, nextOffset, total: items.length });
      }
      if (path === "do/share/create" && request.method === "POST") {
        const { id, retentionHours } = await request.json<{ id: string; retentionHours?: string | number }>();
        const it = await this.state.storage.get<TimelineItem>(`item:${id}`);
        if (!it) return json({ ok: false, error: "not_found" }, 404);
        const token = await randomId(24);
        const rec: ShareRecord = {
          itemId: it.id,
          createdAt: Date.now(),
          expiresAt: Date.now() + 1000 * 60 * 60 * retentionHoursOrDefault(retentionHours),
        };
        await this.state.storage.put(`share:${token}`, rec);
        return json({ ok: true, token, expiresAt: rec.expiresAt });
      }
      if (path === "do/share/resolve" && request.method === "POST") {
        const { token } = await request.json<{ token: string }>();
        const rec = await this.state.storage.get<ShareRecord>(`share:${token}`);
        if (!rec || rec.expiresAt < Date.now())
          return json({ ok: false, error: "invalid_or_expired" }, 404);
        const it = await this.state.storage.get<TimelineItem>(`item:${rec.itemId}`);
        if (!it) return json({ ok: false, error: "gone" }, 404);
        return json({ ok: true, item: it });
      }
      if (path === "do/cleanup" && request.method === "POST") {
        const body = await request.json<{ retentionHours?: string | number }>().catch(() => ({} as { retentionHours?: string | number }));
        const cutoff = Date.now() - 1000 * 60 * 60 * retentionHoursOrDefault(body?.retentionHours);
        const ids = await this.getIndex("items:index");
        // R2 keys of removed file items are queued in "r2:pending" BEFORE the records are
        // deleted, and only dropped after the Worker confirms the R2 delete (do/cleanup/ack).
        const pending = new Set((await this.state.storage.get<string[]>("r2:pending")) ?? []);
        let removed = 0;
        const keep: string[] = [];
        for (const id of ids) {
          const it = await this.state.storage.get<TimelineItem>(`item:${id}`);
          if (!it || it.createdAt < cutoff) {
            if (it?.r2Key) pending.add(it.r2Key);
            removed++;
          } else {
            keep.push(id);
          }
        }
        if (removed) {
          await this.state.storage.put("r2:pending", [...pending]);
          for (const id of ids) {
            if (!keep.includes(id)) await this.state.storage.delete(`item:${id}`);
          }
          await this.state.storage.put("items:index", keep);
          await this.broadcast({ type: "items_changed" });
        }
        return json({ ok: true, removed, r2Keys: [...pending] });
      }
      if (path === "do/cleanup/ack" && request.method === "POST") {
        const { keys } = await request.json<{ keys?: string[] }>().catch(() => ({ keys: [] as string[] }));
        const done = new Set(Array.isArray(keys) ? keys : []);
        const pending = ((await this.state.storage.get<string[]>("r2:pending")) ?? []).filter((k) => !done.has(k));
        await this.state.storage.put("r2:pending", pending);
        return json({ ok: true, remaining: pending.length });
      }
      if (path === "do/rate/record" && request.method === "POST") {
        const { key } = await request.json<{ key: string }>();
        const now = Date.now();
        const arr = (await this.state.storage.get<number[]>(`rl:${key}`)) ?? [];
        const recent = arr.filter(t => now - t < this.RATE_LIMIT_WINDOW_MS);
        recent.push(now);
        await this.state.storage.put(`rl:${key}`, recent);
        const blocked = recent.length > this.RATE_LIMIT_MAX;
        return json({ blocked, attempts: recent.length });
      }
      return new Response("Not found", { status: 404 });
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 500);
    }
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    // optional ping/pong
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message as ArrayBuffer);
      if (text === "ping") ws.send("pong");
    } catch {
      // ignore
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.sockets.delete(ws);
  }

  private async broadcast(payload: unknown) {
    const msg = JSON.stringify(payload);
    for (const ws of this.sockets) {
      try {
        ws.send(msg);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  private async appendIndex(key: string, id: string) {
    const arr = ((await this.state.storage.get<string[]>(key)) ?? []).filter(
      (x) => x !== id
    );
    arr.push(id);
    await this.state.storage.put(key, arr);
  }

  private async removeFromIndex(key: string, id: string) {
    const arr = ((await this.state.storage.get<string[]>(key)) ?? []).filter(
      (x) => x !== id
    );
    await this.state.storage.put(key, arr);
  }

  private async getIndex(key: string): Promise<string[]> {
    return (await this.state.storage.get<string[]>(key)) ?? [];
  }

  private async createSession(deviceId: string): Promise<StoredSession & { token: string }> {
    const token = await randomId(24);
    const now = Date.now();
    const rec: StoredSession = {
      deviceId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    await this.state.storage.put(`sess:${token}`, rec);
    return { token, ...rec };
  }
}

function retentionHoursOrDefault(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

