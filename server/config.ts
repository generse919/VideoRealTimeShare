import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** PATH から実行ファイルを探す */
function findOnPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* not found */
      }
    }
  }
  return null;
}

/**
 * 実行ファイルを探す。PATH → 既知のインストール先の順。
 * winget/choco 等でインストール直後は、既に開いているターミナルのPATHが
 * 更新されない (プロセス起動時点のPATHを引き継ぐため) ことがあるので、
 * よくあるインストール先を直接見に行くフォールバックを用意する。
 */
function findExecutable(name: string, knownPaths: string[]): string | null {
  const onPath = findOnPath(name);
  if (onPath) return onPath;
  for (const p of knownPaths) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not found */
    }
  }
  return null;
}

/** Homebrew (Mac) のよくあるインストール先。Apple Silicon と Intel で異なる */
const MAC_BREW_BINS = ["/opt/homebrew/bin", "/usr/local/bin"];
const macFallback = (name: string): string[] => MAC_BREW_BINS.map((dir) => path.join(dir, name));

/**
 * ffmpeg / ffprobe のパス解決。
 * ImageMagick 等が古い ffmpeg だけを PATH 上位に置いていることがあるため、
 * ffprobe が見つかったディレクトリの ffmpeg を優先する (ffprobe は ffmpeg 本体の配布物にしか含まれないため)。
 */
function resolveFfmpeg(): { ffmpeg: string | null; ffprobe: string | null } {
  const envFfmpeg = process.env.VRT_FFMPEG_PATH;
  const envFfprobe = process.env.VRT_FFPROBE_PATH;
  if (envFfmpeg && envFfprobe) return { ffmpeg: envFfmpeg, ffprobe: envFfprobe };

  const ffprobe = envFfprobe ?? findExecutable("ffprobe", macFallback("ffprobe"));
  let ffmpeg = envFfmpeg ?? null;
  if (!ffmpeg && ffprobe) {
    const sibling = path.join(path.dirname(ffprobe), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    if (fs.existsSync(sibling)) ffmpeg = sibling;
  }
  if (!ffmpeg) ffmpeg = findExecutable("ffmpeg", macFallback("ffmpeg"));
  return { ffmpeg, ffprobe };
}

const { ffmpeg, ffprobe } = resolveFfmpeg();

const cloudflaredPath =
  process.env.VRT_CLOUDFLARED_PATH ??
  findExecutable("cloudflared", [
    "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
    "C:\\Program Files\\cloudflared\\cloudflared.exe",
    path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links", "cloudflared.exe"),
    ...macFallback("cloudflared"),
  ]);

const ngrokPath =
  process.env.VRT_NGROK_PATH ??
  findExecutable("ngrok", [
    path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links", "ngrok.exe"),
    ...macFallback("ngrok"),
  ]);

const defaultMediaDir = path.join(os.homedir(), process.platform === "darwin" ? "Movies" : "Videos");

export const config = {
  projectRoot,
  port: Number(process.env.VRT_PORT ?? 8787),
  mediaDir: process.env.VRT_MEDIA_DIR ?? defaultMediaDir,
  cacheDir: path.join(projectRoot, ".cache"),
  clientDist: path.join(projectRoot, "client", "dist"),
  ffmpegPath: ffmpeg,
  ffprobePath: ffprobe,
  cloudflaredPath,
  ngrokPath,
  // 固定したい場合は環境変数で指定 (毎回URLが変わるのを避けたいとき)
  roomToken: process.env.VRT_ROOM_TOKEN ?? crypto.randomBytes(9).toString("base64url"),
  hostKey: process.env.VRT_HOST_KEY ?? crypto.randomBytes(9).toString("base64url"),
  disableTunnel: process.env.VRT_NO_TUNNEL === "1",
};

export function prepareCacheDir(): void {
  fs.rmSync(config.cacheDir, { recursive: true, force: true });
  fs.mkdirSync(config.cacheDir, { recursive: true });
}
