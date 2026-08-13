# VideoRealTime

友人と動画を低遅延で同時視聴するWebアプリ。ホストのPCにある動画ファイル (mp4 / mkv など) を各視聴者のブラウザへ直接ストリーミングし、**再生位置だけ**をWebSocketで同期します。Discordの画面共有のような映像のライブ配信ではないため、画質は無劣化・再生位置のズレは通常±50ms以内に収まります。

- 想定人数: 2〜4人 (ホスト1人 + ゲスト)
- ボイスチャットは非搭載 (Discord等を併用してください)

## かんたん起動 (非エンジニア向け)

プログラミングの知識やコマンド操作は不要です。**動画を共有する側 (ホスト) だけ**、以下の準備をしてください。ゲストはブラウザで参加するだけです。

1. [Releases ページ](../../releases/latest) から、自分のOSに合ったzipをダウンロード
   - Windows: `VideoRealTime-windows-vX.X.X.zip`
   - Mac: `VideoRealTime-mac-vX.X.X.zip`
2. zipを展開する (右クリック→「すべて展開」/ ダブルクリック)
3. 展開してできた `VideoRealTime` フォルダの中の起動ファイルをダブルクリック
   - Windows: `start.bat`
   - Mac: `start.command` (初回は右クリック→「開く」が必要な場合があります)
4. 数秒待つと自動でブラウザが開きます。共有したい動画を選んで、右側の「共有」欄のURLを友人に送ってください

[Node.js](https://nodejs.org/) (無料) だけは事前にインストールしておく必要があります。他の必要なソフト (ffmpeg / cloudflared) は起動時に自動でインストールを試みます (失敗した場合は画面に手動インストール手順が表示されます)。

開発者の方・ソースから動かしたい方は、下記の「開発」セクションを参照してください。

## 仕組み

- 各クライアントは動画ファイル自体をHTTP (Range対応) で受信し、自分のペースでバッファリング
- サーバーが権威的な再生状態 `{ 一時停止中か, 位置, 更新時刻 }` を保持し、WebSocketで全員に配布
- クライアントはNTP方式でサーバーと時計合わせし、「今あるべき位置」を毎250ms計算
  - ズレ50ms未満: 何もしない
  - 50ms〜1秒: `playbackRate` を±5%調整して気づかれずに追いつく
  - 1秒超: 直接シーク
- ブラウザで再生できない形式 (MKV等) はffmpegで自動変換。コーデックが互換 (H.264等) なら無劣化リマックスなので高速

## 必要なもの (ホストのみ)

- [Node.js](https://nodejs.org/) 20以上
- [ffmpeg](https://ffmpeg.org/) — MKV等の変換に必要 (`winget install Gyan.FFmpeg` / `choco install ffmpeg`)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) — リモート公開に必要 (`winget install Cloudflare.cloudflared`)。無くてもLAN内なら利用可

ゲストはブラウザだけでOKです。

## 使い方

```sh
npm install        # 初回のみ
npm start          # ビルドして起動
```

起動すると次のようなURLが表示されます:

```
リモート (ホスト用URL): https://xxxx.trycloudflare.com/?room=...&host=...
リモート (共有用URL)  : https://xxxx.trycloudflare.com/?room=...   <- これを友人に送る
```

1. **ホスト**: ホスト用URLを開き、名前を入力して参加 → 右パネルから動画を選択
2. **ゲスト**: 共有用URLを開いて参加するだけ
3. ホストの再生・一時停止・シークが全員に同期されます

サイドバーの参加者リストに各自のバッファ状態とズレ (ms) が表示されます。

### 操作方法

- 再生/一時停止ボタン、または映像そのものをクリック/タップ
- 矢印キー ← / → で10秒スキップ
- シークバーにマウスを乗せるとその位置のサムネイルプレビューが表示されます (生成完了まで数十秒かかる場合があります)
- 既定ではホストのみ操作可能です。サイドバーの「設定」→「ゲストにも再生操作を許可」を有効にすると、ゲストも再生/一時停止・シーク・矢印キースキップができるようになります (動画ファイルの選択は引き続きホストのみ)

操作した本人の映像は、サーバーとの通信を待たずにその場で反映されます (楽観的更新)。サーバーからの同期はその直後に届き、値のズレはほぼ生じません。

## 設定 (環境変数)

| 変数 | 既定値 | 説明 |
|---|---|---|
| `VRT_PORT` | `8787` | サーバーポート |
| `VRT_MEDIA_DIR` | `~/Videos` (Macは `~/Movies`) | 動画一覧に表示するフォルダ |
| `VRT_ROOM_TOKEN` / `VRT_HOST_KEY` | 起動ごとにランダム | URLを固定したい場合に指定 |
| `VRT_NO_TUNNEL` | - | `1` で cloudflared を起動しない |
| `VRT_NO_OPEN` | - | `1` で起動時のブラウザ自動起動を無効化 |
| `VRT_FFMPEG_PATH` / `VRT_FFPROBE_PATH` | PATHから自動検出 | ffmpeg/ffprobe の場所を明示 |

ffmpegの自動検出は「ffprobeが見つかったフォルダのffmpeg」を優先します (ImageMagick等が古いffmpegだけをPATHに置いている環境への対策)。

## 開発

```sh
npm run dev        # サーバー(tsx watch) + Vite dev server (http://localhost:5173)
npm run typecheck  # 型チェック
```

構成:

- `server/` — Express + ws。`room.ts` が同期の状態機械、`media.ts` がffprobe判定とffmpeg変換、`tunnel.ts` がcloudflared連携、`launcher.mjs` が配布版の非エンジニア向け起動メッセージ担当
- `client/` — Vite + vanilla TS。`src/sync.ts` がクロック同期とドリフト補正エンジン
- `shared/messages.ts` — WSメッセージの型定義 (両側で共用)

### 配布用ビルド (Releases)

```sh
npm run release   # release/ に Windows用 / Mac用 zip を生成
```

`scripts/build-release.mjs` がクライアントをビルドし、サーバーを esbuild で依存関係込みの単一ファイル (`server/server.mjs`) にバンドルして、`scripts/start.bat` / `scripts/start.command` と一緒にzip化します (利用者はNode.js以外のインストール作業が不要になります)。

`v1.0.0` のようなタグをpushすると、`.github/workflows/release.yml` が自動でこのビルドを実行し、GitHub Releasesにzipを公開します。

```sh
git tag v1.0.0
git push origin v1.0.0
```

## 制限事項

- ルームは1つ、動画は同時に1本
- 変換が必要なファイル (HEVC等) は変換完了まで再生開始できません (映像がH.264なら音声のみ変換で高速)
- 内蔵字幕は現状ドロップされます (焼き込み済み字幕は表示可)
- トンネルURLを知っていれば誰でも参加できるため、URLの共有範囲に注意
