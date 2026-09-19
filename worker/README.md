# 記録のあずかり所（Cloudflare Worker）

スマホのアプリが書き出した記録を置いておく場所。ブログ（mosomoso-history.com/routine）がここを読む。

- `GET` … 置いてある JSON を返す。だれでも読める
- `POST` … あいことば（`x-key` ヘッダ）が合っていれば置きかえる

中身は数字だけ。種目名やスポット作業の名前は入らない。

## 立てる手順

Cloudflare のアカウント（無料）が要る。

```bash
cd C:/ClaudeCode/my-routine/worker
npx wrangler login
npx wrangler kv namespace create RECORDS
```

出てきた `id` を `wrangler.toml` の `id = "ここにKVのidを入れる"` に貼る。つづけて:

```bash
npx wrangler secret put WRITE_KEY
```

あいことばを聞かれるので、自分で決めた長めの文字列を入れる（パスワード管理ソフトで作るとよい）。
**このあいことばはリポジトリに書かない**。公開リポジトリなので、書くと誰でも見られる。

```bash
npx wrangler deploy
```

`https://my-routine-records.<アカウント名>.workers.dev` が出る。これが送信先。

## アプリにつなぐ

アプリの「記録」タブ →「自動で送る」に、上のURLとあいことばを入れる。
この2つはそのスマホの中だけに保存され、書き出すデータには入らない。

## ブログにつなぐ

`mosomoso-history/src/pages/routine.astro` の `DATA_URL` を、上のURLに変える。

## お金

無料枠の中に収まる（Workers 10万リクエスト/日、KV 1000書き込み/日）。
1日に数回送るだけなので、桁がいくつも余る。
