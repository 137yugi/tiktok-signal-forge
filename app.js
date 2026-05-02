const STORE_KEY = "tiktok-signal-forge:v1";
const MAX_EVENTS = 120;
const MAX_DIAGNOSTICS = 160;
const DUP_TTL_MS = 10 * 60 * 1000;

const CLOSE_HINTS = {
  1000: ["WS_CLOSED_NORMAL", "正常に切断しました。"],
  1006: ["WS_CLOSED_ABNORMAL", "異常切断です。電波、LIVE状態、Provider制限を確認してください。"],
  1008: ["WS_POLICY_REJECTED", "Providerが接続を拒否しました。認証または対象制限の可能性があります。"],
  1011: ["WS_SERVER_ERROR", "Providerまたは上流で内部エラーが発生しました。"],
  1013: ["WS_TRY_AGAIN_LATER", "Providerが一時的に混雑しています。時間を置いてください。"],
  4005: ["ROOM_ENDED", "配信が終了しました。"],
  4006: ["HEARTBEAT_TIMEOUT", "受信が一定時間なく切断されました。"],
  4400: ["INPUT_INVALID_ROOM", "TikTok IDまたは接続オプションが不正です。"],
  4401: ["AUTH_FAILED", "認証に失敗しました。"],
  4403: ["ROOM_RESTRICTED", "対象に接続する権限がありません。"],
  4404: ["ROOM_OFFLINE", "対象はLIVE中ではありません。"],
  4429: ["WS_TRY_AGAIN_LATER", "接続数または頻度制限です。"],
  4500: ["WS_CLOSED_ABNORMAL", "TikTok側で切断されました。"],
  4555: ["WS_CLOSED_ABNORMAL", "WebSocketの最大接続時間に達しました。"],
  4556: ["WS_SERVER_ERROR", "Webcast fetchに失敗しました。"],
  4557: ["WS_SERVER_ERROR", "Room info fetchに失敗しました。"],
};

const demoPayload = {
  type: "chat",
  msgId: "demo-comment-1",
  roomId: "demo-room",
  timestamp: Date.now(),
  user: { id: "u1", uniqueId: "demo_user", nickname: "Demo User" },
  comment: "こんにちは #SignalForge",
};

const app = {
  socket: null,
  reconnectTimer: null,
  wakeLock: null,
  reconnectAttempts: 0,
  startedAt: 0,
  lastEventAt: 0,
  timeToOpenMs: 0,
  timeToFirstMessageMs: 0,
  connectStartedAt: 0,
  renderQueued: false,
  seen: new Map(),
  giftStreaks: new Map(),
  settings: {
    uniqueId: "",
    provider: "euler",
    customUrl: "",
    authMode: "none",
    credential: "",
    rememberCredential: false,
  },
  metrics: {
    comments: 0,
    gifts: 0,
    diamonds: 0,
    raw: 0,
  },
  events: [],
  rawSnapshots: [],
  diagnostics: [],
};

const $ = {};

document.addEventListener("DOMContentLoaded", () => {
  bind();
  restore();
  bindEvents();
  seedPayload();
  runQueryDemoIfNeeded();
  renderAll();
  registerServiceWorker();
});

function bind() {
  [
    "statusBadge",
    "connectForm",
    "uniqueIdInput",
    "providerInput",
    "customUrlField",
    "customUrlInput",
    "authDetails",
    "authModeInput",
    "credentialInput",
    "rememberCredentialInput",
    "connectButton",
    "disconnectButton",
    "diagnoseButton",
    "wakeLockButton",
    "notice",
    "commentCount",
    "giftCount",
    "diamondCount",
    "rawCount",
    "sessionLine",
    "timeline",
    "diagnosticsLog",
    "rawLog",
    "copyRawButton",
    "payloadInput",
    "injectButton",
    "demoBurstButton",
    "exportButton",
    "clearButton",
    "copyDiagnosticsButton",
  ].forEach((id) => {
    $[id] = document.getElementById(id);
  });
}

function bindEvents() {
  $.connectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    readSettingsFromForm();
    if (app.settings.provider === "demo") {
      startDemo();
      return;
    }
    connect();
  });

  $.disconnectButton.addEventListener("click", () => disconnect("manual"));
  $.diagnoseButton.addEventListener("click", runDiagnostics);
  $.wakeLockButton.addEventListener("click", toggleWakeLock);
  $.providerInput.addEventListener("change", () => {
    readSettingsFromForm();
    renderConnectionOptions();
    persist();
  });

  [
    $.uniqueIdInput,
    $.customUrlInput,
    $.authModeInput,
    $.credentialInput,
    $.rememberCredentialInput,
  ].forEach((input) => {
    input.addEventListener("input", () => {
      readSettingsFromForm();
      persist();
    });
    input.addEventListener("change", () => {
      readSettingsFromForm();
      persist();
    });
  });

  $.injectButton.addEventListener("click", injectPayload);
  $.demoBurstButton.addEventListener("click", () => demoBurst(20));
  $.exportButton.addEventListener("click", exportJsonl);
  $.clearButton.addEventListener("click", clearAll);
  $.copyDiagnosticsButton.addEventListener("click", copyDiagnostics);
  $.copyRawButton.addEventListener("click", copyRaw);

  window.addEventListener("online", () => logDiag("NETWORK_ONLINE", "オンラインに戻りました。"));
  window.addEventListener("offline", () => {
    setStatus("error", "Offline");
    logDiag("NETWORK_OFFLINE", "ブラウザがオフラインです。");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (app.socket && app.socket.readyState !== WebSocket.OPEN) {
        logDiag("VISIBILITY_RESUME", "復帰時にWebSocketが開いていません。");
      }
      scheduleRender();
      if (app.wakeLock) requestWakeLock();
    }
  });
}

function runQueryDemoIfNeeded() {
  const params = new URLSearchParams(location.search);
  if (params.get("demo") === "1") {
    app.settings.provider = "demo";
    startDemo();
  }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    const settings = saved.settings || {};
    app.settings = {
      ...app.settings,
      ...settings,
      credential: settings.rememberCredential ? settings.credential || "" : "",
    };
  } catch {
    logDiag("STORAGE_RESTORE_FAILED", "保存設定を復元できませんでした。初期値で起動します。");
  }
}

function persist() {
  const settings = {
    ...app.settings,
    credential: app.settings.rememberCredential ? app.settings.credential : "",
  };
  localStorage.setItem(STORE_KEY, JSON.stringify({ settings }));
}

function readSettingsFromForm() {
  app.settings.uniqueId = normalizeUniqueId($.uniqueIdInput.value);
  app.settings.provider = $.providerInput.value;
  app.settings.customUrl = $.customUrlInput.value.trim();
  app.settings.authMode = $.authModeInput.value;
  app.settings.credential = $.credentialInput.value.trim();
  app.settings.rememberCredential = $.rememberCredentialInput.checked;
}

function writeSettingsToForm() {
  $.uniqueIdInput.value = app.settings.uniqueId;
  $.providerInput.value = app.settings.provider;
  $.customUrlInput.value = app.settings.customUrl;
  $.authModeInput.value = app.settings.authMode;
  $.credentialInput.value = app.settings.credential;
  $.rememberCredentialInput.checked = app.settings.rememberCredential;
  renderConnectionOptions();
}

function renderConnectionOptions() {
  $.customUrlField.hidden = app.settings.provider !== "custom";
  $.authDetails.hidden = app.settings.provider === "demo" || app.settings.provider === "custom";
}

function connect() {
  const validation = validateConnectionSettings();
  if (!validation.ok) {
    setStatus("error", "Invalid");
    note(validation.message);
    logDiag(validation.code, validation.message);
    return;
  }

  disconnect("replace", false);
  const url = buildProviderUrl();
  app.startedAt = Date.now();
  app.connectStartedAt = Date.now();
  app.timeToOpenMs = 0;
  app.timeToFirstMessageMs = 0;
  app.lastEventAt = 0;
  app.reconnectAttempts = 0;
  setStatus("connecting", "Connecting");
  setButtons(true);
  note("接続を開始しました。コメント/ギフト受信を待っています。");
  logDiag("WS_CONNECTING", `provider=${app.settings.provider} creator=@${app.settings.uniqueId || "custom"}`);

  try {
    const socket = new WebSocket(url);
    app.socket = socket;
    socket.addEventListener("open", () => {
      app.timeToOpenMs = Date.now() - app.connectStartedAt;
      setStatus("connected", "Connected");
      logDiag("WS_CONNECTED", `WebSocketを開きました。timeToOpen=${app.timeToOpenMs}ms`);
      note("接続済み。実イベントが届くと下に表示します。");
      scheduleRender();
    });
    socket.addEventListener("message", (message) => {
      if (!app.timeToFirstMessageMs) app.timeToFirstMessageMs = Date.now() - app.connectStartedAt;
      app.lastEventAt = Date.now();
      handleRawMessage(message.data);
    });
    socket.addEventListener("error", () => {
      setStatus("error", "WS Error");
      logDiag("WS_HANDSHAKE_FAILED", "WebSocket error。ブラウザは詳細なHTTP理由を隠す場合があります。");
      note("WebSocketエラーです。ID、LIVE状態、認証方式、Provider制限を確認してください。");
    });
    socket.addEventListener("close", (event) => {
      const [code, message] = CLOSE_HINTS[event.code] || ["WS_CLOSED_ABNORMAL", event.reason || "切断されました。"];
      app.socket = null;
      logDiag(code, `${event.code} ${message}`);
      setButtons(false);
      if (event.code === 1000) {
        setStatus("idle", "Idle");
        note(message);
        scheduleRender();
        return;
      }
      setStatus("error", "Closed");
      note(message);
      scheduleReconnect();
    });
  } catch (error) {
    setStatus("error", "Failed");
    setButtons(false);
    logDiag("WS_CREATE_FAILED", error.message);
    note(error.message);
  }
}

function disconnect(reason = "manual", update = true) {
  clearTimeout(app.reconnectTimer);
  app.reconnectTimer = null;
  if (app.socket) {
    const socket = app.socket;
    app.socket = null;
    socket.onclose = null;
    socket.close(1000, reason);
  }
  if (update) {
    setStatus("idle", "Idle");
    setButtons(false);
    logDiag("WS_STOPPED", reason);
    note("停止しました。");
    scheduleRender();
  }
}

function scheduleReconnect() {
  if (!navigator.onLine) return;
  if (!["euler", "custom"].includes(app.settings.provider)) return;
  app.reconnectAttempts += 1;
  if (app.reconnectAttempts > 5) {
    logDiag("RECONNECT_GIVE_UP", "再接続を5回で停止しました。");
    return;
  }
  const delay = Math.min(30000, 1200 * 2 ** app.reconnectAttempts);
  setStatus("reconnecting", `Retry ${Math.round(delay / 1000)}s`);
  logDiag("WS_RECONNECT_SCHEDULED", `${Math.round(delay / 1000)}秒後に再接続します。`);
  app.reconnectTimer = setTimeout(connect, delay);
}

function validateConnectionSettings() {
  if (app.settings.provider === "euler") {
    if (!app.settings.uniqueId) {
      return { ok: false, code: "INPUT_INVALID_ROOM", message: "TikTok IDを入力してください。" };
    }
    if (app.settings.authMode !== "none" && !app.settings.credential) {
      return { ok: false, code: "AUTH_VALUE_REQUIRED", message: "選択した認証方式には認証値が必要です。" };
    }
  }
  if (app.settings.provider === "custom") {
    if (!/^wss:\/\//i.test(app.settings.customUrl)) {
      return { ok: false, code: "MIXED_CONTENT_BLOCKED", message: "Custom URLは wss:// で始めてください。" };
    }
  }
  return { ok: true };
}

function buildProviderUrl() {
  if (app.settings.provider === "custom") {
    return app.settings.customUrl.replaceAll("{uniqueId}", encodeURIComponent(app.settings.uniqueId));
  }
  const params = new URLSearchParams({ uniqueId: app.settings.uniqueId });
  if (app.settings.authMode === "apiKey") params.set("apiKey", app.settings.credential);
  if (app.settings.authMode === "jwtKey") params.set("jwtKey", app.settings.credential);
  return `wss://ws.eulerstream.com?${params.toString()}`;
}

function handleRawMessage(rawData) {
  app.metrics.raw += 1;
  let parsed;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    logDiag("PAYLOAD_PARSE_FAILED", `JSONではないpayload: ${String(rawData).slice(0, 120)}`);
    scheduleRender();
    return;
  }

  app.rawSnapshots.unshift(redact(parsed));
  app.rawSnapshots = app.rawSnapshots.slice(0, 20);
  const packets = flattenPayload(parsed);
  packets.forEach((packet) => ingestPacket(packet, parsed));
  scheduleRender();
}

function flattenPayload(payload) {
  if (Array.isArray(payload)) return payload;
  const keys = ["messages", "events", "data", "payloads", "items"];
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  if (payload?.message && typeof payload.message === "object") return [payload.message];
  if (payload?.event && typeof payload.event === "object") return [payload.event];
  return [payload];
}

function ingestPacket(packet, rawRoot = packet) {
  const event = normalizePacket(packet, rawRoot);
  if (event.type === "unsupported") {
    pushEvent(event);
    logDiag("PAYLOAD_UNSUPPORTED", `type=${event.rawType || "unknown"} keys=${Object.keys(packet || {}).slice(0, 10).join(",")}`);
    return;
  }

  const dedupe = evaluateDedupe(event);
  if (dedupe.status === "duplicate") {
    logDiag("DUPLICATE_SKIPPED", `${event.type} ${event.id}`);
    return;
  }

  rememberAccepted(event, dedupe);
  if (event.type === "comment") app.metrics.comments += 1;
  if (event.type === "gift") {
    const delta = Math.max(0, dedupe.countDelta || Math.max(1, event.repeatCount || 1));
    app.metrics.gifts += delta;
    app.metrics.diamonds += Math.max(0, (event.diamondCount || 0) * delta);
    event.countDelta = delta;
    event.dedupeStatus = dedupe.status;
  }
  pushEvent(event);
}

function normalizePacket(packet, rawRoot) {
  const rawType = pickString(packet, ["type", "eventType", "event", "msgType", "method", "name", "messageType"]);
  const typeText = rawType.toLowerCase();
  const user = pickObject(packet, ["user", "sender", "author", "fromUser", "member", "userInfo"]) || {};
  const gift = pickObject(packet, ["gift", "giftInfo", "giftDetails", "giftData", "extendedGift"]) || {};
  const id = pickString(packet, ["id", "msgId", "messageId", "eventId", "logId"]) || stableId(packet);
  const ts = pickNumber(packet, ["timestamp", "createTime", "eventTime", "createdAt", "time"]) || Date.now();
  const nickname =
    pickString(user, ["nickname", "nickName", "displayName", "uniqueId", "unique_id", "id"]) ||
    pickString(packet, ["nickname", "uniqueId", "unique_id", "userName"]) ||
    "unknown";
  const uniqueId =
    pickString(user, ["uniqueId", "unique_id", "secUid", "id"]) ||
    pickString(packet, ["uniqueId", "unique_id", "userId"]) ||
    "";

  const comment = pickString(packet, ["comment", "text", "content", "message", "displayText"]);
  const giftName =
    pickString(gift, ["name", "giftName", "gift_name", "title"]) ||
    pickString(packet, ["giftName", "gift_name", "giftId", "gift_id"]) ||
    "";
  const repeatCount =
    pickNumber(packet, ["repeatCount", "repeat_count", "comboCount", "combo_count", "count"]) ||
    pickNumber(gift, ["repeatCount", "repeat_count"]) ||
    1;
  const repeatEnd = Boolean(packet.repeatEnd ?? packet.repeat_end ?? packet.repeatEndFlag ?? false);
  const diamondCount =
    pickNumber(gift, ["diamondCount", "diamond_count", "cost", "price", "diamond"]) ||
    pickNumber(packet, ["diamondCount", "diamond_count", "giftValue"]) ||
    0;

  const inferredType = inferType({ typeText, comment, giftName, packet });
  if (inferredType === "comment") {
    return {
      type: "comment",
      rawType,
      id,
      ts,
      nickname,
      uniqueId,
      text: comment || "",
      summary: comment || "(empty comment)",
      raw: redact(rawRoot),
    };
  }

  if (inferredType === "gift") {
    return {
      type: "gift",
      rawType,
      id,
      ts,
      nickname,
      uniqueId,
      giftId: pickString(gift, ["id", "giftId", "gift_id"]) || pickString(packet, ["giftId", "gift_id"]) || "",
      giftName: giftName || "Gift",
      repeatCount: Number(repeatCount) || 1,
      repeatEnd,
      diamondCount: Number(diamondCount) || 0,
      summary: `${giftName || "Gift"} x${Number(repeatCount) || 1}`,
      streakKey: `${uniqueId || nickname}:${pickString(gift, ["id", "giftId", "gift_id"]) || giftName || "Gift"}`,
      raw: redact(rawRoot),
    };
  }

  return {
    type: "unsupported",
    rawType,
    id,
    ts,
    nickname,
    uniqueId,
    summary: `unsupported ${rawType || "payload"}`,
    raw: redact(rawRoot),
  };
}

function inferType({ typeText, comment, giftName, packet }) {
  if (typeText.includes("gift")) return "gift";
  if (typeText.includes("chat") || typeText.includes("comment")) return "comment";
  if (giftName || packet.giftId || packet.gift_id || packet.repeatCount || packet.repeat_count) return "gift";
  if (typeof comment === "string" && comment.length > 0) return "comment";
  return "unsupported";
}

function pushEvent(event) {
  app.events.unshift(event);
  app.events = app.events.slice(0, MAX_EVENTS);
  scheduleRender();
}

function evaluateDedupe(event) {
  pruneSeen();
  if (event.type !== "gift") {
    return app.seen.has(event.id) ? { status: "duplicate" } : { status: "accepted" };
  }

  const streakKey = event.streakKey || event.id;
  const previous = app.giftStreaks.get(streakKey);
  if (previous && event.repeatCount <= previous.repeatCount && !event.repeatEnd) {
    return { status: "duplicate", countDelta: 0 };
  }
  const delta = previous ? Math.max(0, event.repeatCount - previous.repeatCount) : Math.max(1, event.repeatCount || 1);
  if (previous && delta === 0 && event.repeatEnd === previous.repeatEnd) {
    return { status: "duplicate", countDelta: 0 };
  }
  return { status: previous ? "updated" : "accepted", countDelta: delta };
}

function rememberAccepted(event, dedupe) {
  app.seen.set(event.id, Date.now());
  if (event.type === "gift") {
    app.giftStreaks.set(event.streakKey || event.id, {
      at: Date.now(),
      repeatCount: event.repeatCount || 1,
      repeatEnd: event.repeatEnd,
      status: dedupe.status,
    });
  }
}

function pruneSeen() {
  const cutoff = Date.now() - DUP_TTL_MS;
  for (const [id, at] of app.seen.entries()) {
    if (at < cutoff) app.seen.delete(id);
  }
  for (const [key, streak] of app.giftStreaks.entries()) {
    if (streak.at < cutoff || streak.repeatEnd) app.giftStreaks.delete(key);
  }
}

function startDemo() {
  disconnect("demo", false);
  app.startedAt = Date.now();
  setStatus("connected", "Demo");
  setButtons(true);
  note("Demo Generatorで解析器を動かしています。");
  logDiag("DEMO_STARTED", "デモpayloadを投入します。");
  demoBurst(8);
}

function demoBurst(count = 20) {
  for (let index = 0; index < count; index += 1) {
    const payload = index % 3 === 0 ? demoGift(index) : demoComment(index);
    acceptLocalPayload(payload);
  }
  scheduleRender();
}

function demoComment(index) {
  return {
    ...demoPayload,
    msgId: `demo-comment-${Date.now()}-${index}`,
    timestamp: Date.now() + index,
    user: { uniqueId: `viewer_${index}`, nickname: `Viewer ${index}` },
    comment: index % 5 === 0 ? "長文テスト🔥".repeat(18) : `コメント ${index}`,
  };
}

function demoGift(index) {
  return {
    type: "gift",
    msgId: `demo-gift-${Date.now()}-${index}`,
    timestamp: Date.now() + index,
    user: { uniqueId: `gifter_${index}`, nickname: `Gifter ${index}` },
    gift: { id: "5655", name: index % 2 ? "Rose" : "Galaxy", diamondCount: index % 2 ? 1 : 1000 },
    repeatCount: (index % 4) + 1,
    repeatEnd: index % 2 === 0,
  };
}

function seedPayload() {
  $.payloadInput.value = JSON.stringify(
    [
      demoPayload,
      {
        type: "gift",
        msgId: "demo-gift-1",
        roomId: "demo-room",
        timestamp: Date.now(),
        user: { id: "u2", uniqueId: "gift_user", nickname: "Gift QA" },
        gift: { id: "5655", name: "Rose", diamondCount: 1 },
        repeatCount: 3,
        repeatEnd: true,
      },
    ],
    null,
    2,
  );
}

function injectPayload() {
  let parsed;
  try {
    parsed = JSON.parse($.payloadInput.value);
  } catch (error) {
    logDiag("PAYLOAD_PARSE_FAILED", error.message);
    scheduleRender();
    return;
  }
  flattenPayload(parsed).forEach((packet) => acceptLocalPayload(packet, parsed));
  logDiag("PAYLOAD_INJECTED", "手動payloadを投入しました。");
  scheduleRender();
}

function acceptLocalPayload(packet, rawRoot = packet) {
  app.metrics.raw += 1;
  app.rawSnapshots.unshift(redact(rawRoot));
  app.rawSnapshots = app.rawSnapshots.slice(0, 20);
  ingestPacket(packet, rawRoot);
}

function runDiagnostics() {
  readSettingsFromForm();
  const notes = [];
  notes.push(`origin=${location.origin}`);
  notes.push(`online=${navigator.onLine}`);
  notes.push(`provider=${app.settings.provider}`);
  notes.push(`creator=@${app.settings.uniqueId || "(empty)"}`);
  notes.push(`websocket=${"WebSocket" in window}`);
  notes.push(`serviceWorker=${"serviceWorker" in navigator}`);
  notes.push(`secureContext=${window.isSecureContext}`);
  logDiag("DIAGNOSTIC", notes.join(" / "));
  note("診断を記録しました。Diagnosticsを確認してください。");
  scheduleRender();
}

function clearAll() {
  app.metrics = { comments: 0, gifts: 0, diamonds: 0, raw: 0 };
  app.events = [];
  app.rawSnapshots = [];
  app.diagnostics = [];
  app.seen.clear();
  app.giftStreaks.clear();
  scheduleRender();
}

function exportJsonl() {
  const confirmed = window.confirm(
    "Exportにはユーザー名、コメント本文、ギフト名など公開配信内の内容が含まれます。認証値はredactします。続行しますか？",
  );
  if (!confirmed) return;
  const lines = app.events
    .slice()
    .reverse()
    .map((event) => JSON.stringify(redact(event)))
    .join("\n");
  const blob = new Blob([lines], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `signal-forge-${new Date().toISOString().replaceAll(":", "-")}.jsonl`;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyDiagnostics() {
  const text = app.diagnostics.map(formatDiagnostic).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    note("redacted diagnosticsをコピーしました。");
  } catch {
    note("コピーできませんでした。Diagnostics欄から手動でコピーしてください。");
  }
}

async function copyRaw() {
  const text = app.rawSnapshots.map((item) => JSON.stringify(item)).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    note("redacted raw payloadをコピーしました。");
  } catch {
    note("Rawをコピーできませんでした。");
  }
}

async function toggleWakeLock() {
  if (!("wakeLock" in navigator)) {
    logDiag("WAKE_LOCK_UNAVAILABLE", "このブラウザではWake Lockが使えません。");
    note("Wake Lock非対応です。画面ロックに注意してください。");
    return;
  }
  if (app.wakeLock) {
    await app.wakeLock.release();
    app.wakeLock = null;
    $.wakeLockButton.textContent = "Wake Lock";
    logDiag("WAKE_LOCK_RELEASED", "Wake Lockを解除しました。");
    return;
  }
  await requestWakeLock();
}

async function requestWakeLock() {
  try {
    app.wakeLock = await navigator.wakeLock.request("screen");
    $.wakeLockButton.textContent = "Unlock Screen";
    app.wakeLock.addEventListener("release", () => {
      app.wakeLock = null;
      $.wakeLockButton.textContent = "Wake Lock";
    });
    logDiag("WAKE_LOCK_ACTIVE", "画面Wake Lockを取得しました。");
  } catch (error) {
    logDiag("WAKE_LOCK_FAILED", error.message);
  }
}

function logDiag(code, message) {
  app.diagnostics.unshift({
    at: new Date().toISOString(),
    code,
    message: redactText(message),
    provider: app.settings.provider,
    reconnectAttempts: app.reconnectAttempts,
  });
  app.diagnostics = app.diagnostics.slice(0, MAX_DIAGNOSTICS);
}

function formatDiagnostic(item) {
  return `${item.at} ${item.code} provider=${item.provider} retry=${item.reconnectAttempts} ${item.message}`;
}

function scheduleRender() {
  if (app.renderQueued) return;
  app.renderQueued = true;
  requestAnimationFrame(() => {
    app.renderQueued = false;
    renderAll();
  });
}

function renderAll() {
  writeSettingsToForm();
  renderConnectionOptions();
  $.commentCount.textContent = String(app.metrics.comments);
  $.giftCount.textContent = String(app.metrics.gifts);
  $.diamondCount.textContent = String(app.metrics.diamonds);
  $.rawCount.textContent = String(app.metrics.raw);
  renderSession();
  renderTimeline();
  renderDiagnostics();
  renderRaw();
}

function renderSession() {
  if (!app.startedAt) {
    $.sessionLine.textContent = "未開始";
    return;
  }
  const elapsed = Math.floor((Date.now() - app.startedAt) / 1000);
  const last = app.lastEventAt ? `${Math.floor((Date.now() - app.lastEventAt) / 1000)}秒前` : "未受信";
  $.sessionLine.textContent = `経過 ${elapsed}秒 / 最終受信 ${last} / open ${app.timeToOpenMs || "-"}ms / first ${app.timeToFirstMessageMs || "-"}ms / events ${app.events.length}`;
}

function renderTimeline() {
  $.timeline.textContent = "";
  if (!app.events.length) {
    const row = document.createElement("div");
    row.className = "empty-row";
    row.textContent = "まだイベントがありません。Demo Burstか実接続で信号を入れてください。";
    $.timeline.appendChild(row);
    return;
  }
  app.events.slice(0, 50).forEach((event) => {
    const row = document.createElement("article");
    row.className = "event-row";
    const title =
      event.type === "gift"
        ? `${event.nickname} sent ${event.giftName}`
        : event.type === "comment"
          ? event.nickname
          : event.summary;
    row.innerHTML = `
      <span class="event-type ${escapeHtml(event.type)}">${escapeHtml(event.type)}</span>
      <div class="event-body">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(event.summary || event.text || "")}${event.countDelta ? ` / delta ${event.countDelta}` : ""}</span>
      </div>
      <time>${escapeHtml(formatTime(event.ts))}</time>
    `;
    $.timeline.appendChild(row);
  });
}

function renderDiagnostics() {
  $.diagnosticsLog.textContent = app.diagnostics.length
    ? app.diagnostics.map(formatDiagnostic).join("\n")
    : "診断ログはまだありません。";
}

function renderRaw() {
  $.rawLog.textContent = app.rawSnapshots.length
    ? app.rawSnapshots.map((item) => JSON.stringify(item, null, 2)).join("\n\n")
    : "まだRaw payloadはありません。";
}

function setStatus(state, label) {
  $.statusBadge.dataset.state = state;
  $.statusBadge.textContent = label;
}

function setButtons(active) {
  $.connectButton.disabled = active && app.settings.provider !== "demo";
  $.disconnectButton.disabled = !active;
}

function note(message) {
  $.notice.textContent = message;
}

function normalizeUniqueId(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, "")
    .replace(/\/live.*$/i, "")
    .replace(/^@/, "")
    .trim();
}

function pickObject(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] && typeof obj[key] === "object") return obj[key];
  }
  return null;
}

function pickString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.length) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

function pickNumber(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    const number = Number(value);
    if (Number.isFinite(number) && number !== 0) return number;
  }
  return 0;
}

function stableId(value) {
  const text = JSON.stringify(value, Object.keys(value || {}).sort());
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return `hash-${hash.toString(16)}`;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return typeof value === "string" ? redactText(value) : value;
  const output = {};
  Object.entries(value).forEach(([key, item]) => {
    if (/token|cookie|session|api.?key|jwt|secret|signature|msToken|verifyFp|odin/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redact(item);
    }
  });
  return output;
}

function redactText(text) {
  return String(text || "")
    .replace(/(apiKey|jwtKey|token|sessionid|cookie|_signature|X-Bogus)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z0-9_-]{28,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[REDACTED_JWT]");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(ts) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ts));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    logDiag("PWA_SW_FAILED", error.message);
    scheduleRender();
  });
}
