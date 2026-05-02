# TikTok Signal Forge

スマホChromeを含むブラウザだけで動く、TikTok LIVEコメント/ギフト信号の解析器です。

## 結論

完全なTikTok直読みはMVPから外しています。ブラウザはCORS、任意ヘッダー禁止、Cookie/署名の扱い、Service Workerのスコープ制限があるため、静的ページからTikTok内部Webcastへ安定接続する設計は成立性が低いです。

このアプリは次の2段階で「自前サーバーなし」を満たします。

```text
スマホChrome / 静的PWA
  -> ブラウザ対応WebSocket Provider
  -> コメント/ギフトpayloadを解析
  -> 重複除外、診断、JSONL export
```

少人数検証では上の直接接続で十分です。多人数で同じ配信を使う場合は、同梱の `relay/` をCloudflare Workersへ置くと、1つのTikTok IDにつき上流接続を1本だけにできます。

```text
スマホChrome / 静的PWA
  -> Cloudflare Signal Relay
  -> Euler WebSocket / TikTok LIVE
```

これでTikFinityは不要です。ブラウザだけでHTTP待受をすることはできないため、厳密な「中継ゼロ」ではなく、Cloudflareに置く保守不要の薄い中継で成立させます。

Providerは `Auto` が初期値です。`Signal Relay URL` があればRelayを使い、未設定なら Euler WebSocket direct で検証します。API keyをブラウザへ保存する場合は端末LocalStorageに残るため、公開配布ではRelay側secretまたは短命JWTを推奨します。

## 起動

```bash
python3 -m http.server 4174 --directory tiktok-signal-forge
```

PC:

```text
http://127.0.0.1:4174/
```

スマホ:

```text
http://<MacのLAN IP>:4174/
```

## GitHub Pages

このフォルダ単体をGitHubリポジトリにしてpushすると、`.github/workflows/pages.yml` がGitHub Actionsで静的ファイルをPagesへデプロイします。

```bash
cd tiktok-signal-forge
git init
git branch -M main
git add .
git commit -m "Initial Signal Forge"
git remote add origin git@github.com:<user>/<repo>.git
git push -u origin main
```

GitHub側では `Settings -> Pages -> Build and deployment -> Source` を `GitHub Actions` にします。Actionsが完了すると、workflowの `github-pages` environment URLから開けます。

## 使い方

1. `TikTok ID` に対象IDを入れる。
2. `このIDで拾う` を押す。
3. コメント/ギフトが届けば `Live Monitor` に出る。
4. 失敗時だけ `接続できない時だけ開く` を開き、Diagnosticsや認証方式を確認する。

URLから直接起動する場合:

```text
https://137yugi.github.io/tiktok-signal-forge/?id=<TikTokID>&autostart=1
```

`Provider=Demo Generator` ならネットワークなしで解析器だけ試せます。

## TikFinityなしの多人数構成

CloudflareへRelayをデプロイします。

```bash
cd relay
npm install
npx wrangler whoami
npx wrangler deploy
```

デプロイ後、PWAの `Signal Relay URL` に次の形で入れます。

```text
https://<worker-name>.<account>.workers.dev/ws
```

URLに埋め込む場合:

```text
https://137yugi.github.io/tiktok-signal-forge/?relay=https://<worker-name>.<account>.workers.dev/ws&id=<TikTokID>&autostart=1
```

この構成では、同じTikTok IDを見ている参加者が増えても上流接続はDurable Object内の1本に集約されます。下流のスマホ/PCはWorkerへWebSocket接続するだけです。

## コスト/保守の目安

運用対象はCloudflare Worker 1つだけです。DBは使わず、イベントも保存しません。

| 規模 | 想定 | 月額の見方 |
| --- | --- | --- |
| 友人/小規模テスト | 同時100人程度、短時間 | Free枠で収まる可能性が高い |
| 通常イベント | 同時1,000人程度、数時間 | Workers Paidの最低$5/月を見込む |
| 大規模 | 同時10,000人以上 | `/stats` を見てshard分割。$5/月から上振れを監視 |

Cloudflareの課金上、WebSocket接続開始はrequestとして数えられます。Durable Objectはアクティブな時間にcompute durationが出ますが、このrelayは保存処理を持たず、1配信1上流接続に集約するため、人数増加でTikTok/Euler側の接続数が増えません。

保守作業は基本的に次の3つです。

1. Cloudflareの請求アラートを見る。
2. LIVE前に `/health` と `/stats?uniqueId=<TikTokID>` を見る。
3. TikTok/Euler側仕様変更で上流が切れたらRelay URLではなく上流Providerを差し替える。

## 実装した新規性

- Provider Adapter前提で、Euler以外の `wss://...` も差し替え可能
- コメント/ギフトを複数ライブラリ由来のfield名から推定
- `CommentEvent` / `GiftEvent` 系の概念をブラウザ内schemaへ正規化
- gift streak / repeatCount / repeatEnd を保持
- msgId/eventId/logId/hashによる重複除外
- ギフトstreak更新は `repeatCount` の差分で集計
- reconnect backoff
- redacted diagnostics
- Wake Lock対応ブラウザでは画面ロック抑制
- JSONL export
- PWA cache

## 参考にした一次情報

- TikTok-Live-Connector README: Node.js向けで、ブラウザ表示には転送サーバーまたはEuler WebSocket APIが必要
- Euler WebSocket Docs: `wss://ws.eulerstream.com` とfrontendではJWT推奨
- MDN CORS: browser fetch/XHRはCORSで制限される
- MDN Forbidden request headers: Cookie/Origin/Host/Sec-*などはJSから任意設定不可
- MDN WebSocket: browser constructorはURLとsubprotocolのみ
- TikTokLive Python README: `CommentEvent`, `GiftEvent`, `repeat_count`, `repeat_end`, `gift.name`
