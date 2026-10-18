# Stream Deck Herdr

[Herdr](https://herdr.dev) で動いているコーディングエージェント（Claude Code / Codex など）の状態を Stream Deck のキーに表示し、承認待ちのエージェントをキー一押しで承認・フォーカスするプラグインです。Herdr はローカルでも、SSH 経由のリモート PC でも接続できます。

## 機能

| アクション | 内容 |
| --- | --- |
| **Agent** | 1 キー = 1 エージェント。状態色（blocked / working / done / idle）とタイトルを表示。短押しと長押し（0.6 秒）の動作は Approve / Decline / Focus pane から選択（既定: 短押し Approve、長押し Decline）。 |
| **Agent Slot** | 注意順（blocked → done → working → idle）に並べた N 番目のエージェントを自動表示。1〜8 を横一列に置くと「承認待ちが左に集まる一覧」になる。 |
| **Agent Dial**（Stream Deck +） | Herdr でフォーカス中のエージェントを表示。ダイヤルを回すと前後のエージェントに Herdr のフォーカスが移る（Herdr 側で pane を切り替えるとダイヤルも追従）。押下 / 長押しの動作は Agent キーと同じく選択式（既定: Approve / Decline）、タッチでフォーカス。 |

- 承認は `agent.send_keys`（既定 `enter`）、拒否は `esc`。キーはアクションごとに変更可能（例: `2`、`down enter`）。
- Approve / Decline は送信直前に `agent.get` で状態を再確認し、blocked 以外にはキーを送らず pane をフォーカスします（Safety 設定で解除可）。
- 複数ホストを登録でき、Slot / Dial は「All hosts」で全ホストを横断できます。

## 接続方式

| モード | 仕組み |
| --- | --- |
| **Local** | この PC の Herdr ソケットに直結。`herdr status --json` でソケットパス（Windows は名前付きパイプ）を自動検出。 |
| **SSH** | リモート PC に SSH で接続し、OpenSSH の Unix ソケット転送（`streamlocal@openssh.com`）で `herdr.sock` に直接チャネルを開く。リモート側に追加インストールは不要（Herdr と sshd だけ）。認証はパスワード / 鍵ファイル / ssh-agent。 |

SSH 接続は Node 実装の [`ssh2`](https://github.com/mscdex/ssh2) を使うため、Stream Deck アプリに TTY が無くてもパスワード認証が使えます。ホスト鍵は初回接続時に学習し（TOFU）、以後フィンガープリントが変わると接続を拒否します（PI の「Reset host key」で再学習）。

> **注意**: Stream Deck はグローバル設定を平文 JSON で保存します。パスワードやパスフレーズもそのまま保存されるため、可能なら鍵認証または ssh-agent を使ってください。

## 必要なもの

- Stream Deck アプリ 7.1 以上（Node.js 24 ランタイム）。macOS 13+ / Windows 10+
- Herdr 0.9 以上（接続先の PC）。SSH モードではリモート sshd で `AllowStreamLocalForwarding`（既定 yes）が有効なこと

## インストール

### リリースファイルから

`dist/com.sogaani.herdr.streamDeckPlugin` をダブルクリックすると Stream Deck アプリに登録されます。

### ソースから

```bash
npm install
npm run build          # packages/herdr-client と plugin をビルド
npm test               # vitest
npm run pack           # dist/com.sogaani.herdr.streamDeckPlugin を生成
npm run check-bundle -w plugin   # バンドル化した ssh2 でパスワード認証とソケット転送を検証
```

開発中は Stream Deck CLI でリンクすると変更が即座に反映されます。

```bash
npx streamdeck link plugin/com.sogaani.herdr.sdPlugin
npm run watch -w plugin   # 変更ごとにビルド & プラグイン再起動
```

ログは `plugin/com.sogaani.herdr.sdPlugin/logs/` に出力されます。

## セットアップ手順

1. Stream Deck アプリで **Herdr › Agent Slot** をキーにドラッグします。
2. Property Inspector 下部の **Hosts › Add host** でホストを登録します。
   - **Local**: ラベルだけで OK。名前付きセッションを使っている場合は Herdr session を入力。
   - **SSH**: Host に IP アドレス / ドメイン / `~/.ssh/config` のエイリアス、User、認証方式を入力。`~/.ssh/config` に `HostName` / `User` / `Port` / `IdentityFile` があれば自動で補完されます。
   - **Test connection** で疎通確認。成功するとエージェント数とホスト鍵のフィンガープリントが表示されます。
   - Herdr の保存済みマシン（`herdr machine list`）がある場合は **Import from Herdr** で取り込めます（SSH ユーザー名と認証は追記してください）。
3. Slot を 1〜8 にしたキーを並べれば完成です。固定のエージェントを見たい場合は **Agent** アクションで Host と Agent を選びます。

## 承認キーについて

短押し / 長押しそれぞれに **Approve**（Approve keys を送信）、**Decline**（Deny keys を送信）、**Focus pane**（Herdr でその pane にフォーカス）を割り当てられます。Claude Code の権限ダイアログでは `enter` が選択中の項目（通常は「Yes」）、`esc` が拒否です。「今後も許可」を選びたい場合は Approve keys を `2` や `down enter` に変えてください。Herdr が受け付けるキー名は `enter`, `esc`, `up`, `down`, `tab`, `ctrl+c`, 文字や数字などです。

## トラブルシューティング

| 症状 | 確認すること |
| --- | --- |
| キーが OFFLINE のまま（Local） | 接続先 PC で Herdr が起動しているか。`herdr status --json` が通るか。Stream Deck から `herdr` が見つからない場合は Host 設定の *herdr binary* に絶対パスを入力 |
| OFFLINE: `All configured authentication methods failed` | SSH のユーザー名・パスワード・鍵を確認。パスフレーズ付き鍵は Passphrase 欄に入力 |
| OFFLINE: `administratively prohibited` | リモート sshd の `AllowStreamLocalForwarding` が無効。`/etc/ssh/sshd_config` を確認 |
| OFFLINE: `cannot locate herdr.sock` | リモートの非対話シェルで `herdr` が PATH に無い。Host 設定の *Remote socket* に `~/.config/herdr/herdr.sock` などの絶対パスを入力 |
| `SSH host key changed` | 接続先のホスト鍵が変わった。意図したものなら Edit → **Reset host key** |
| 承認が送られない | エージェントが `blocked` と認識されていない。Herdr のサイドバーで状態を確認。常に送るには *Safety* のチェックを外す |

## リポジトリ構成

```
packages/herdr-client/   Herdr ソケット API クライアント（NDJSON）、AgentWatcher、SSH トランスポート（ssh2）
plugin/                  Stream Deck プラグイン本体（@elgato/streamdeck v3、rollup）
  com.sogaani.herdr.sdPlugin/   manifest.json, ui/（Property Inspector）, imgs/, layouts/
```

`packages/herdr-client/scripts/` にはライブ検証用のスクリプトがあります。

```bash
# ローカル Herdr の状態変化を流し見る
npx tsx packages/herdr-client/scripts/watch-agents.ts

# SSH 経由で疎通確認（パスワードは対話入力）
npx tsx packages/herdr-client/scripts/ssh-smoke.ts workbox --user you --password
npx tsx packages/herdr-client/scripts/ssh-smoke.ts 192.168.1.20 --user you --key ~/.ssh/id_ed25519 --watch
```

## ライセンス

MIT
