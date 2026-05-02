# TikTok Signal Forge

スマホChromeを含むブラウザだけで動く、TikTok LIVEコメント/ギフト信号の解析器です。

## 結論

完全なTikTok直読みはMVPから外しています。ブラウザはCORS、任意ヘッダー禁止、Cookie/署名の扱い、Service Workerのスコープ制限があるため、静的ページからTikTok内部Webcastへ安定接続する設計は成立性が低いです。

このアプリは次の形で「自前サーバーなし」を満たします。

```text
スマホChrome / 静的PWA
  -> ブラウザ対応WebSocket Provider
  -> コメント/ギフトpayloadを解析
  -> 重複除外、診断、JSONL export
```

デフォルトProviderは Euler WebSocket です。認証なし、API key、JWTを選べます。API keyを保存する場合は端末LocalStorageに残るため、公開配布では短命JWTやBYOK運用を推奨します。

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

1. `TikTok ID / LIVE URL` に対象IDを入れる。
2. `Provider` はまず `Euler WebSocket` のままにする。
3. 必要なら認証方式と認証値を入れる。
4. `Start` を押す。
5. コメント/ギフトが届けば `Live Monitor` に出る。
6. 失敗時は `Diagnostics` のコードを見る。

`Provider=Demo Generator` ならネットワークなしで解析器だけ試せます。

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
