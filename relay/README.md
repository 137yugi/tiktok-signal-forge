# TikTok Signal Relay

TikFinityなしで、1つのTikTok LIVE上流接続を複数ブラウザへ配るCloudflare Worker + Durable Objectです。

```text
TikTok / Euler WebSocket
  -> Cloudflare Durable Object room
  -> iOS / Android / PC Chrome clients
```

## 使い方

```bash
cd relay
npm install
npx wrangler whoami
npx wrangler deploy
```

デプロイ後に出るWorker URLをPWAの `Signal Relay URL` に入れます。

```text
https://<worker-name>.<account>.workers.dev/ws
```

PWAのURLへ埋め込む場合:

```text
https://137yugi.github.io/tiktok-signal-forge/?relay=https://<worker-name>.<account>.workers.dev/ws&id=<TikTokID>&autostart=1
```

## Secret

EulerのAPI key/JWTをブラウザへ出したくない場合はWorker側のsecretに入れます。

```bash
npx wrangler secret put EULER_API_KEY
# or
npx wrangler secret put EULER_JWT
```

外部publish endpointを保護する場合:

```bash
npx wrangler secret put PUBLISH_TOKEN
```

`POST /publish?uniqueId=<TikTokID>` に `Authorization: Bearer <PUBLISH_TOKEN>` または `x-signal-token` を付けると、テストpayloadを接続中クライアントへ配れます。

## エンドポイント

- `GET /health`: relayの生存確認
- `GET /ws?uniqueId=<TikTokID>`: ブラウザ向けWebSocket
- `GET /stats?uniqueId=<TikTokID>`: 接続数と上流状態
- `POST /publish?uniqueId=<TikTokID>`: テスト/外部イベント投入

## スケール方針

Durable Objectは `uniqueId` ごとに1部屋です。同じ配信を見ている参加者が何人いても、Euler/TikTok側への上流接続は1本だけに抑え、下流WebSocketだけを増やします。

部屋が巨大化した場合は、`uniqueId:shard` で複数部屋に分ける余地があります。まずは1配信1部屋で始めて、`/stats` の `clients` と遅延を見て判断します。
