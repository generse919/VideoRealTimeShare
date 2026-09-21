import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MediaInfo } from "../shared/messages.ts";
import { config } from "./config.ts";

interface ProbeResult {
  formatName: string;
  duration: number;
  videoCodec: string | null;
  audioCodec: string | null;
}

/** ブラウザの <video> (MP4) でそのまま再生できる映像コーデック */
const DIRECT_VIDEO = new Set(["h264", "av1", "vp9"]);
const DIRECT_AUDIO = new Set(["aac", "mp3", "opus", "flac"]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".ts", ".wmv", ".flv", ".mpg", ".mpeg"]);

export function isVideoFile(file: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * YouTube の各種URL表記から動画IDを取り出す。
 * youtu.be/ID / watch?v=ID / embed/ID / shorts/ID / live/ID、およびID直書きに対応。
 */
export function parseYoutubeId(input: string): string | null {
  const text = input.trim();
  if (/^[\w-]{11}$/.test(text)) return text;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean);

  const valid = (id: string | undefined): string | null => (id && /^[\w-]{11}$/.test(id) ? id : null);

  if (host === "youtu.be") return valid(segments[0]);
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com" && host !== "youtube-nocookie.com") {
    return null;
  }
  if (segments[0] === "watch") return valid(url.searchParams.get("v") ?? undefined);
  if (segments[0] === "embed" || segments[0] === "shorts" || segments[0] === "live" || segments[0] === "v") {
    return valid(segments[1]);
  }
  return valid(url.searchParams.get("v") ?? undefined);
}

function runFfprobe(file: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    if (!config.ffprobePath) return reject(new Error("ffprobe が見つかりません。ffmpeg をインストールしてください。"));
    const proc = spawn(config.ffprobePath, [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      file,
    ]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe が失敗しました: ${err.trim().slice(-300)}`));
      try {
        const json = JSON.parse(out);
        const streams: any[] = json.streams ?? [];
        const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
        const audio = streams.find((s) => s.codec_type === "audio");
        resolve({
          formatName: json.format?.format_name ?? "",
          duration: Number(json.format?.duration ?? video?.duration ?? 0),
          videoCodec: video?.codec_name ?? null,
          audioCodec: audio?.codec_name ?? null,
        });
      } catch (e) {
        reject(new Error(`ffprobe の出力を解析できません: ${e}`));
      }
    });
  });
}

/** 変換せずそのまま Range 配信できるか */
function isDirectPlayable(file: string, probe: ProbeResult): boolean {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".webm") return true; // webm はブラウザネイティブ
  const isMp4Container = /\b(mp4|mov)\b/.test(probe.formatName) || ext === ".mp4" || ext === ".m4v";
  if (!isMp4Container) return false;
  if (!probe.videoCodec || !DIRECT_VIDEO.has(probe.videoCodec)) return false;
  if (probe.audioCodec && !DIRECT_AUDIO.has(probe.audioCodec)) return false;
  return true;
}

export class MediaManager {
  info: MediaInfo = {
    status: "none",
    kind: "file",
    youtubeId: null,
    fileName: null,
    duration: null,
    progress: null,
    error: null,
    version: 0,
    direct: false,
    thumbInterval: null,
    thumbCount: null,
  };
  /** 配信対象のファイル (ready のときのみ有効) */
  servePath: string | null = null;
  /** 生成済みサムネイルの格納先 (thumbCount が確定してから有効) */
  thumbDir: string | null = null;

  private currentProc: ChildProcess | null = null;
  private thumbProc: ChildProcess | null = null;
  private prepareSeq = 0;

  constructor(private onUpdate: (info: MediaInfo) => void) {}

  private update(patch: Partial<MediaInfo>): void {
    this.info = { ...this.info, ...patch };
    this.onUpdate(this.info);
  }

  /** ホストが選択したファイルを配信可能な状態にする */
  async prepare(filePath: string): Promise<void> {
    const seq = ++this.prepareSeq;
    this.cancelConversion();
    this.cancelThumbnails();
    this.servePath = null;
    const fileName = path.basename(filePath);
    this.update({
      status: "probing",
      kind: "file",
      youtubeId: null,
      fileName,
      duration: null,
      progress: null,
      error: null,
      version: this.info.version + 1,
      direct: false,
      thumbInterval: null,
      thumbCount: null,
    });

    try {
      if (!fs.existsSync(filePath)) throw new Error(`ファイルが見つかりません: ${filePath}`);
      const probe = await runFfprobe(filePath);
      if (seq !== this.prepareSeq) return; // 別のファイルが選択された

      if (isDirectPlayable(filePath, probe)) {
        this.servePath = filePath;
        this.markReady(probe.duration, true, seq);
        return;
      }
      await this.convert(filePath, probe, seq);
    } catch (e) {
      if (seq !== this.prepareSeq) return;
      this.update({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * YouTube動画を共有対象にする。映像はサーバーを経由せず各クライアントが
   * YouTubeから直接受信するため、ffprobe / ffmpeg は一切使わず即 ready になる。
   * 長さ (duration) はホストのプレイヤーが判明時に reportDuration で報告する。
   */
  setYoutube(youtubeId: string, label: string): void {
    ++this.prepareSeq;
    this.cancelConversion();
    this.cancelThumbnails();
    this.servePath = null;
    this.update({
      status: "ready",
      kind: "youtube",
      youtubeId,
      fileName: label,
      duration: null,
      progress: null,
      error: null,
      version: this.info.version + 1,
      direct: true,
      thumbInterval: null,
      thumbCount: null,
    });
  }

  /** ホストのプレイヤーから報告された長さを反映する (YouTube用) */
  setReportedDuration(version: number, duration: number): boolean {
    if (version !== this.info.version || this.info.kind !== "youtube") return false;
    if (!Number.isFinite(duration) || duration <= 0) return false;
    if (this.info.duration != null && Math.abs(this.info.duration - duration) < 0.5) return false;
    this.update({ duration });
    return true;
  }

  private markReady(duration: number, direct: boolean, seq: number): void {
    this.update({ status: "ready", duration, direct, progress: direct ? null : 100 });
    this.startThumbnails(seq, duration);
  }

  /** ブラウザ非対応の形式を MP4 へ変換 (互換ストリームは無劣化コピー) */
  private convert(filePath: string, probe: ProbeResult, seq: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!config.ffmpegPath) return reject(new Error("ffmpeg が見つかりません。ffmpeg をインストールしてください。"));
      const outPath = path.join(config.cacheDir, `converted-${this.info.version}.mp4`);

      const videoArgs =
        probe.videoCodec && DIRECT_VIDEO.has(probe.videoCodec)
          ? ["-c:v", "copy"]
          : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p"];
      const audioArgs =
        !probe.audioCodec || (DIRECT_AUDIO.has(probe.audioCodec) && probe.audioCodec !== "opus" && probe.audioCodec !== "flac")
          ? ["-c:a", "copy"]
          : ["-c:a", "aac", "-b:a", "192k", "-ac", "2"];

      const args = [
        "-y",
        "-i", filePath,
        "-map", "0:v:0",
        ...(probe.audioCodec ? ["-map", "0:a:0"] : []),
        ...videoArgs,
        ...audioArgs,
        "-sn",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        "-loglevel", "error",
        outPath,
      ];

      this.update({ status: "converting", duration: probe.duration, progress: 0 });
      const proc = spawn(config.ffmpegPath, args);
      this.currentProc = proc;

      let stderr = "";
      let lastEmit = 0;
      proc.stderr.on("data", (d) => (stderr += d));
      proc.stdout.on("data", (d) => {
        const text = String(d);
        const m = text.match(/out_time_us=(\d+)/) ?? text.match(/out_time_ms=(\d+)/);
        if (m && probe.duration > 0) {
          const progress = Math.min(99, (Number(m[1]) / 1e6 / probe.duration) * 100);
          const now = Date.now();
          if (now - lastEmit > 500) {
            lastEmit = now;
            if (seq === this.prepareSeq) this.update({ progress: Math.round(progress * 10) / 10 });
          }
        }
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (this.currentProc === proc) this.currentProc = null;
        if (seq !== this.prepareSeq) return resolve(); // キャンセル済み
        if (code !== 0) {
          return reject(new Error(`ffmpeg の変換に失敗しました (exit ${code}): ${stderr.trim().slice(-300)}`));
        }
        this.servePath = outPath;
        this.markReady(probe.duration, false, seq);
        resolve();
      });
    });
  }

  private cancelConversion(): void {
    if (this.currentProc) {
      this.currentProc.kill("SIGKILL");
      this.currentProc = null;
    }
  }

  /**
   * シークバーのホバープレビュー用サムネイルを裏で生成する。
   * 再生開始をブロックしないよう ready 状態にした後に非同期で走らせ、
   * 完了したら thumbCount を更新して通知する (未完了の間はプレビューなし)。
   */
  private startThumbnails(seq: number, duration: number): void {
    this.cancelThumbnails();
    if (!config.ffmpegPath || !this.servePath || duration <= 0) return;
    const dir = path.join(config.cacheDir, `thumbs-${this.info.version}`);
    fs.mkdirSync(dir, { recursive: true });
    const interval = Math.min(15, Math.max(2, duration / 80));

    const proc = spawn(config.ffmpegPath, [
      "-y",
      "-i", this.servePath,
      "-vf", `fps=1/${interval},scale=160:-1`,
      "-q:v", "5",
      "-start_number", "0",
      "-loglevel", "error",
      path.join(dir, "thumb-%04d.jpg"),
    ]);
    this.thumbProc = proc;
    proc.on("error", () => {
      if (this.thumbProc === proc) this.thumbProc = null;
    });
    proc.on("close", (code) => {
      if (this.thumbProc === proc) this.thumbProc = null;
      if (seq !== this.prepareSeq || code !== 0) return;
      let count = 0;
      try {
        count = fs.readdirSync(dir).length;
      } catch {
        /* ignore */
      }
      if (count === 0) return;
      this.thumbDir = dir;
      this.update({ thumbInterval: interval, thumbCount: count });
    });
  }

  private cancelThumbnails(): void {
    if (this.thumbProc) {
      this.thumbProc.kill("SIGKILL");
      this.thumbProc = null;
    }
    this.thumbDir = null;
  }
}
