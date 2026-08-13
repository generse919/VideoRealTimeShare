import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import type { MediaFileEntry } from "../shared/messages.ts";
import { config, prepareCacheDir } from "./config.ts";
import { isVideoFile } from "./media.ts";
import { Room } from "./room.ts";
import { startTunnel } from "./tunnel.ts";

prepareCacheDir();

let tunnelUrl: string | null = null;
const origin = () => tunnelUrl ?? `http://localhost:${config.port}`;
const shareUrl = () => `${origin()}/?room=${config.roomToken}`;
const hostUrl = () => `${shareUrl()}&host=${config.hostKey}`;

const room = new Room(() => ({ tunnelUrl, shareUrl: shareUrl() }));

const app = express();
app.use(express.json());

/** ルームトークン検証 (動画・API 共通) */
function requireToken(req: express.Request, res: express.Response): boolean {
  if (req.query.room !== config.roomToken) {
    res.status(403).json({ error: "invalid room token" });
    return false;
  }
  return true;
}

function requireHost(req: express.Request, res: express.Response): boolean {
  if (!requireToken(req, res)) return false;
  if (req.query.host !== config.hostKey) {
    res.status(403).json({ error: "host key required" });
    return false;
  }
  return true;
}

/** メディアフォルダ内の動画ファイル一覧 (ホスト用) */
app.get("/api/files", (req, res) => {
  if (!requireHost(req, res)) return;
  const entries: MediaFileEntry[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 3 || entries.length >= 500) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= 500) return;
      const abs = path.join(dir, item.name);
      const relName = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        walk(abs, relName, depth + 1);
      } else if (item.isFile() && isVideoFile(item.name)) {
        try {
          entries.push({ name: relName, path: abs, size: fs.statSync(abs).size });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(config.mediaDir, "", 0);
  entries.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  res.json({ mediaDir: config.mediaDir, files: entries });
});

/** 動画本体。Range リクエスト対応は res.sendFile (send) が処理する */
app.get("/video", (req, res) => {
  if (!requireToken(req, res)) return;
  const servePath = room.media.servePath;
  if (room.media.info.status !== "ready" || !servePath) {
    res.status(404).json({ error: "no media ready" });
    return;
  }
  res.sendFile(servePath, { acceptRanges: true, cacheControl: false });
});

/** シークバーのホバープレビュー用サムネイル */
app.get("/thumb", (req, res) => {
  if (!requireToken(req, res)) return;
  const version = Number(req.query.v);
  const index = Number(req.query.i);
  const { thumbDir, info } = room.media;
  if (!thumbDir || version !== info.version || !Number.isInteger(index) || index < 0) {
    res.status(404).end();
    return;
  }
  const file = path.join(thumbDir, `thumb-${String(index).padStart(4, "0")}.jpg`);
  res.sendFile(file, (err) => {
    if (err) res.status(404).end();
  });
});

// ビルド済みクライアント (npm run build 後)
if (fs.existsSync(config.clientDist)) {
  app.use(express.static(config.clientDist));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws" || url.searchParams.get("room") !== config.roomToken) {
    socket.destroy();
    return;
  }
  const name = url.searchParams.get("name") ?? "";
  const isHost = url.searchParams.get("host") === config.hostKey;
  wss.handleUpgrade(req, socket, head, (ws) => {
    room.join(ws, name, isHost);
  });
});

server.listen(config.port, () => {
  console.log("");
  console.log("=== VideoRealTime 起動 ===");
  console.log(`ローカル (ホスト用URL): ${hostUrl()}`);
  console.log(`ローカル (共有用URL)  : ${shareUrl()}`);
  console.log(`メディアフォルダ      : ${config.mediaDir} (VRT_MEDIA_DIR で変更可)`);
  if (!config.ffmpegPath) console.warn("警告: ffmpeg が見つかりません。MKV 等の変換ができません。");
  if (!fs.existsSync(config.clientDist)) {
    console.log("注意: client/dist がありません。開発時は `npm run dev` で http://localhost:5173 を使ってください。");
  }
  console.log("");
  startTunnel((url) => {
    tunnelUrl = url;
    if (url) {
      console.log(`リモート (ホスト用URL): ${hostUrl()}`);
      console.log(`リモート (共有用URL)  : ${shareUrl()}  <- これを友人に送る`);
    }
    room.notifyTunnelChanged();
  });
});
