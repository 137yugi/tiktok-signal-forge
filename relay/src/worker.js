import { DurableObject } from "cloudflare:workers";

const DEFAULT_EULER_WS_BASE = "wss://ws.eulerstream.com";
const MAX_RECONNECTS = 8;
const CLIENT_TAG = "client";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "tiktok-signal-relay",
        routes: ["/ws?uniqueId=<TikTokID>", "/stats?uniqueId=<TikTokID>", "/publish?uniqueId=<TikTokID>"],
      });
    }

    if (url.pathname === "/ws" || url.pathname === "/stats" || url.pathname === "/publish") {
      const uniqueId = normalizeUniqueId(url.searchParams.get("uniqueId") || url.searchParams.get("id"));
      if (!uniqueId) return json({ ok: false, error: "uniqueId is required" }, 400);
      const id = env.LIVE_ROOMS.idFromName(uniqueId.toLowerCase());
      return env.LIVE_ROOMS.get(id).fetch(request);
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

export class LiveRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.upstream = null;
    this.upstreamRoom = "";
    this.upstreamState = "idle";
    this.upstreamStartedAt = 0;
    this.lastEventAt = 0;
    this.retryTimer = null;
    this.retries = 0;
    this.manualUpstreamClose = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const uniqueId = normalizeUniqueId(url.searchParams.get("uniqueId") || url.searchParams.get("id"));

    if (url.pathname === "/stats") {
      return json(this.stats(uniqueId));
    }

    if (url.pathname === "/publish" && request.method === "POST") {
      return this.publish(request, uniqueId);
    }

    if (url.pathname !== "/ws") {
      return json({ ok: false, error: "not found" }, 404);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ ok: false, error: "expected websocket upgrade" }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [CLIENT_TAG, `room:${uniqueId}`]);

    this.sendControl(server, "relay.connected", `Signal Relayへ接続しました。room=@${uniqueId}`);
    this.ensureUpstream(uniqueId);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async publish(request, uniqueId) {
    if (!this.isPublishAllowed(request)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    const text = await request.text();
    if (!text) return json({ ok: false, error: "empty body" }, 400);
    this.lastEventAt = Date.now();
    this.broadcast(text);
    this.broadcastControl("relay.publish", `外部publishを配信しました。room=@${uniqueId}`);
    return json({ ok: true, clients: this.activeClientCount() });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    try {
      const packet = JSON.parse(message);
      if (packet?.type === "ping") {
        this.sendControl(ws, "relay.pong", "pong");
      }
      if (packet?.type === "stats") {
        ws.send(JSON.stringify({ type: "relay.stats", ...this.stats(this.upstreamRoom) }));
      }
    } catch {
      this.sendControl(ws, "relay.info", "client message ignored");
    }
  }

  webSocketClose() {
    setTimeout(() => this.closeUpstreamIfIdle(), 1000);
  }

  webSocketError() {
    setTimeout(() => this.closeUpstreamIfIdle(), 1000);
  }

  ensureUpstream(uniqueId) {
    if (!uniqueId) return;
    if (this.upstream && this.upstreamRoom === uniqueId) return;

    this.closeUpstream("switch room");
    this.upstreamRoom = uniqueId;
    this.openUpstream(uniqueId);
  }

  openUpstream(uniqueId) {
    const url = this.buildUpstreamUrl(uniqueId);
    this.upstreamState = "connecting";
    this.upstreamStartedAt = Date.now();
    this.broadcastControl("relay.upstream_connecting", `上流へ接続中です。room=@${uniqueId}`);

    try {
      const ws = new WebSocket(url);
      this.upstream = ws;

      ws.addEventListener("open", () => {
        this.upstreamState = "open";
        this.retries = 0;
        this.broadcastControl("relay.upstream_open", `上流WebSocketを開きました。room=@${uniqueId}`);
      });

      ws.addEventListener("message", (event) => {
        this.handleUpstreamMessage(event.data);
      });

      ws.addEventListener("close", (event) => {
        const wasManual = this.manualUpstreamClose;
        this.manualUpstreamClose = false;
        this.upstream = null;
        this.upstreamState = "closed";
        this.broadcastControl(
          "relay.upstream_closed",
          `上流が切断されました。code=${event.code} reason=${event.reason || "-"}`,
        );
        if (!wasManual && this.activeClientCount() > 0) this.scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        this.upstreamState = "error";
        this.broadcastControl("relay.error", "上流WebSocketでエラーが発生しました。");
      });
    } catch (error) {
      this.upstreamState = "error";
      this.upstream = null;
      this.broadcastControl("relay.error", error.message);
      this.scheduleReconnect();
    }
  }

  async handleUpstreamMessage(data) {
    const text = await toText(data);
    this.lastEventAt = Date.now();
    this.broadcast(text);
  }

  scheduleReconnect() {
    if (this.retryTimer || this.retries >= MAX_RECONNECTS || !this.upstreamRoom) return;
    const delay = Math.min(30000, 1000 * 2 ** this.retries);
    this.retries += 1;
    this.upstreamState = "retrying";
    this.broadcastControl("relay.upstream_retry", `${Math.round(delay / 1000)}秒後に再接続します。`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.activeClientCount() > 0) this.openUpstream(this.upstreamRoom);
    }, delay);
  }

  closeUpstream(reason) {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.upstream) return;
    this.manualUpstreamClose = true;
    try {
      this.upstream.close(1000, reason);
    } catch {
      // Already closed.
    }
    this.upstream = null;
    this.upstreamState = "idle";
  }

  closeUpstreamIfIdle() {
    if (this.activeClientCount() > 0) return;
    this.closeUpstream("no clients");
  }

  activeClientCount() {
    return this.ctx.getWebSockets(CLIENT_TAG).filter((ws) => ws.readyState === WebSocket.OPEN).length;
  }

  buildUpstreamUrl(uniqueId) {
    const base = this.env.EULER_WS_BASE || DEFAULT_EULER_WS_BASE;
    const url = new URL(base);
    url.searchParams.set("uniqueId", uniqueId);
    if (this.env.EULER_API_KEY) url.searchParams.set("apiKey", this.env.EULER_API_KEY);
    if (this.env.EULER_JWT) url.searchParams.set("jwtKey", this.env.EULER_JWT);
    return url.toString();
  }

  isPublishAllowed(request) {
    if (!this.env.PUBLISH_TOKEN) return true;
    const expected = `Bearer ${this.env.PUBLISH_TOKEN}`;
    return (
      request.headers.get("Authorization") === expected ||
      request.headers.get("x-signal-token") === this.env.PUBLISH_TOKEN
    );
  }

  broadcast(text) {
    for (const ws of this.ctx.getWebSockets(CLIENT_TAG)) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(text);
      } catch {
        try {
          ws.close(1011, "send failed");
        } catch {
          // Ignore double close.
        }
      }
    }
  }

  broadcastControl(type, message) {
    const payload = JSON.stringify({
      type,
      message,
      room: this.upstreamRoom,
      clients: this.activeClientCount(),
      upstreamState: this.upstreamState,
      at: new Date().toISOString(),
    });
    this.broadcast(payload);
  }

  sendControl(ws, type, message) {
    ws.send(
      JSON.stringify({
        type,
        message,
        room: this.upstreamRoom,
        clients: this.activeClientCount(),
        upstreamState: this.upstreamState,
        at: new Date().toISOString(),
      }),
    );
  }

  stats(uniqueId) {
    return {
      ok: true,
      room: uniqueId || this.upstreamRoom,
      clients: this.activeClientCount(),
      upstreamState: this.upstreamState,
      upstreamStartedAt: this.upstreamStartedAt || null,
      lastEventAt: this.lastEventAt || null,
      retries: this.retries,
    };
  }
}

function normalizeUniqueId(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, "")
    .replace(/\/live.*$/i, "")
    .replace(/^@/, "")
    .trim();
}

async function toText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return JSON.stringify(data);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-signal-token",
  };
}
