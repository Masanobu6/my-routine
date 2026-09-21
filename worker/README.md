# 記録のあずかり所（Cloudflare Worker）

アプリのデータを預かり、端末どうしで同期させる場所。ブログ（mosomoso-history.com/routine）の集計もここから読む。

| 道 | 中身 | 鍵 |
|---|---|---|
| `GET /` | ブログに載せる集計 | いらない（公開） |
| `POST /` | 集計を置きかえる | 要る |
| `POST /auth/google` | Google の身分証を確かめ、端末トークンを発行する | いらない（身分証そのものが鍵） |
| `GET /auth/me` | 誰として入っているか | 要る |
| `GET /data` / `POST /data` | データ一式。版つき書き込み（食い違えば 409） | 要る |
| `GET /history`（`?v=N`） | 直近20版の一覧／中身 | 要る |

「鍵」は `x-token`（Googleで入った端末の合鍵）か `x-key`（あいことば）のどちらか。
同期の仕組みはリポジトリ直下の README の「同期の作り」を参照。

## 立ててある場所

**https://records.mosomoso-history.com**

直したら:

```bash
cd C:/ClaudeCode/my-routine/worker && npx wrangler deploy
```

`wrangler.toml` の `routes` は **`[vars]` より前**に書く。あとに書くと vars の中身として読まれ、
独自ドメインが外れて workers.dev に出てしまう（2026-09-21 に一度やった）。

## 設定

| 名前 | 種類 | 中身 |
|---|---|---|
| `RECORDS` | KV | `wrangler.toml` に id（秘密ではない） |
| `GOOGLE_CLIENT_ID` | var | `wrangler.toml` に書いてある（公開してよい値） |
| `ALLOW_EMAILS` | secret | 入ってよいGoogleアカウント（カンマ区切り）。公開リポジトリなので書かない |
| `WRITE_KEY` | secret | あいことば。**リポジトリにもチャットにも書かない** |

secret は Cloudflare のダッシュボード（Workers → my-routine-records → Settings → Variables）か、
`npx wrangler secret put 名前` で入れる。

## お金

無料枠の中に収まる（Workers 10万リクエスト/日、KV 1000書き込み/日）。
