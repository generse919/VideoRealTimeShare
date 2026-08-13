import type { MediaFileEntry, MediaInfo, Participant, PlaybackState } from "../../shared/messages.ts";
import { ClockSync, SyncEngine } from "./sync.ts";
import { SocketClient } from "./ws.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const joinScreen = $("join-screen");
const joinError = $("join-error");
const nameInput = $<HTMLInputElement>("name-input");
const joinBtn = $<HTMLButtonElement>("join-btn");
const appEl = $("app");
const video = $<HTMLVideoElement>("video");
const mediaOverlay = $("media-overlay");
const clickToPlay = $<HTMLButtonElement>("click-to-play");
const playBtn = $<HTMLButtonElement>("play-btn");
const timeLabel = $("time-label");
const seekWrap = $("seek-wrap");
const seekBar = $<HTMLInputElement>("seek");
const seekPreview = $("seek-preview");
const seekPreviewImg = $<HTMLImageElement>("seek-preview-img");
const seekPreviewTime = $("seek-preview-time");
const driftLabel = $("drift-label");
const volumeBar = $<HTMLInputElement>("volume");
const fullscreenBtn = $<HTMLButtonElement>("fullscreen-btn");
const shareUrlInput = $<HTMLInputElement>("share-url");
const copyBtn = $<HTMLButtonElement>("copy-btn");
const tunnelNote = $("tunnel-note");
const participantsList = $("participants");
const hostSettings = $("host-settings");
const guestControlToggle = $<HTMLInputElement>("guest-control-toggle");
const mediaSection = $("media-section");
const pathInput = $<HTMLInputElement>("path-input");
const pathBtn = $<HTMLButtonElement>("path-btn");
const mediaDirLabel = $("media-dir");
const fileList = $("file-list");
const refreshFilesBtn = $<HTMLButtonElement>("refresh-files");
const connStatus = $("conn-status");

const params = new URLSearchParams(location.search);
const roomToken = params.get("room");
const hostKey = params.get("host");

let isHost = false;
let allowGuestControl = false;
let media: MediaInfo | null = null;
let lastPlayback: PlaybackState | null = null;
let selfId: string | null = null;
let buffering = false;
let seekDragging = false;

function canControl(): boolean {
  return isHost || allowGuestControl;
}

const clock = new ClockSync();
const engine = new SyncEngine(video, clock, (blocked) => {
  clickToPlay.hidden = !blocked;
});

// ---- 参加画面 ----

if (!roomToken) {
  joinError.textContent = "URLにルーム情報がありません。ホストから共有されたURLを開いてください。";
  joinError.hidden = false;
  nameInput.disabled = true;
  joinBtn.disabled = true;
}
nameInput.value = localStorage.getItem("vrt-name") ?? "";
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});

let socket: SocketClient | null = null;

joinBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name || !roomToken) return;
  localStorage.setItem("vrt-name", name);
  joinBtn.disabled = true;

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const query = new URLSearchParams({ room: roomToken, name });
  if (hostKey) query.set("host", hostKey);
  socket = new SocketClient(`${proto}://${location.host}/ws?${query}`, onMessage, (connected) => {
    connStatus.textContent = connected ? "" : "サーバーに再接続中...";
  });
  socket.connect();
});

// ---- サーバーメッセージ処理 ----

function onMessage(msg: import("../../shared/messages.ts").ServerMessage): void {
  switch (msg.type) {
    case "welcome":
      selfId = msg.selfId;
      isHost = msg.isHost;
      allowGuestControl = msg.allowGuestControl;
      joinScreen.hidden = true;
      appEl.hidden = false;
      mediaSection.hidden = !isHost;
      hostSettings.hidden = !isHost;
      guestControlToggle.checked = allowGuestControl;
      lastPlayback = msg.playback;
      clock.addSample(msg.serverTime, msg.serverTime); // 仮サンプル (直後のpingで上書き)
      applyMedia(msg.media);
      engine.setState(msg.playback);
      engine.start();
      renderParticipants(msg.participants);
      applyTunnel(msg.tunnelUrl, msg.shareUrl);
      startPingLoop();
      startStatusLoop();
      if (isHost) void loadFileList();
      break;
    case "pong":
      clock.addSample(msg.t0, msg.serverTime);
      break;
    case "playback":
      lastPlayback = msg.playback;
      engine.setState(msg.playback);
      playBtn.textContent = msg.playback.paused ? "▶" : "⏸";
      break;
    case "media":
      applyMedia(msg.media);
      break;
    case "participants":
      renderParticipants(msg.participants);
      break;
    case "tunnel":
      applyTunnel(msg.tunnelUrl, msg.shareUrl);
      break;
    case "settings":
      allowGuestControl = msg.allowGuestControl;
      guestControlToggle.checked = allowGuestControl;
      updateControlAvailability();
      break;
    case "error":
      alert(msg.message);
      break;
  }
}

function startPingLoop(): void {
  // 起動直後は連続して精度を上げ、その後は10秒ごと
  let burst = 0;
  const burstTimer = setInterval(() => {
    socket?.send({ type: "ping", t0: Date.now() });
    if (++burst >= 5) clearInterval(burstTimer);
  }, 300);
  setInterval(() => socket?.send({ type: "ping", t0: Date.now() }), 10000);
}

function startStatusLoop(): void {
  setInterval(() => {
    socket?.send({
      type: "status",
      driftMs: engine.driftMs(),
      buffering,
      ready: video.readyState >= 3,
    });
  }, 2000);
}

// ---- メディア状態 ----

let loadedVersion = -1;

function applyMedia(next: MediaInfo): void {
  media = next;
  const { status } = next;

  if (status === "ready" && loadedVersion !== next.version && roomToken) {
    loadedVersion = next.version;
    video.src = `/video?room=${encodeURIComponent(roomToken)}&v=${next.version}`;
    video.load();
  }

  if (status === "none") {
    mediaOverlay.textContent = isHost
      ? "右のパネルから共有する動画を選択してください"
      : "ホストが動画を選択するのを待っています...";
    mediaOverlay.hidden = false;
  } else if (status === "probing") {
    mediaOverlay.textContent = `${next.fileName ?? ""} を解析中...`;
    mediaOverlay.hidden = false;
  } else if (status === "converting") {
    mediaOverlay.textContent = `${next.fileName ?? ""} をブラウザ用に変換中... ${next.progress?.toFixed(1) ?? 0}%`;
    mediaOverlay.hidden = false;
  } else if (status === "error") {
    mediaOverlay.textContent = `エラー: ${next.error}`;
    mediaOverlay.hidden = false;
  } else {
    mediaOverlay.hidden = true;
  }
  updateControlAvailability();
  updateTimeUi();
}

function updateControlAvailability(): void {
  const enabled = canControl() && media?.status === "ready";
  playBtn.disabled = !enabled;
  seekBar.disabled = !enabled;
}

// ---- 再生コントロール ----
//
// 操作した本人の映像は、サーバーへ送って応答が返るのを待たずに
// その場で video 要素へ反映する (楽観的更新)。往復通信を待つと
// 通信状況によっては操作から反映までのラグが目立つため。
// サーバーからの正式なブロードキャストが届いた時点で上書きされるが、
// 値はほぼ一致するので体感できるズレは生じない。

function applyOptimistic(paused: boolean, position: number): void {
  const state: PlaybackState = { paused, position, updatedAt: clock.serverNow() };
  lastPlayback = state;
  engine.setState(state);
  playBtn.textContent = paused ? "▶" : "⏸";
}

function requestPlayPause(): void {
  if (!canControl() || !media || media.status !== "ready" || !lastPlayback) return;
  const pausedNow = lastPlayback.paused;
  const position = engine.expectedPosition() ?? video.currentTime;
  applyOptimistic(!pausedNow, position);
  socket?.send({ type: pausedNow ? "play" : "pause" });
}

function requestSeek(position: number): void {
  if (!canControl() || !media || media.status !== "ready" || !lastPlayback) return;
  const duration = media.duration ?? position;
  const clamped = Math.max(0, Math.min(position, duration));
  applyOptimistic(lastPlayback.paused, clamped);
  socket?.send({ type: "seek", position: clamped });
}

function requestSkip(deltaSec: number): void {
  const base = engine.expectedPosition() ?? video.currentTime;
  requestSeek(base + deltaSec);
}

playBtn.addEventListener("click", () => requestPlayPause());

seekBar.addEventListener("input", () => {
  seekDragging = true;
  updateTimeUi();
});
seekBar.addEventListener("change", () => {
  seekDragging = false;
  if (!media?.duration) return;
  const position = (Number(seekBar.value) / 1000) * media.duration;
  requestSeek(position);
});

// シークバーへのホバーで再生位置のサムネイルプレビューを表示
seekWrap.addEventListener("mousemove", (e) => {
  if (!media?.duration || !roomToken) return;
  const rect = seekBar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const time = ratio * media.duration;

  seekPreviewTime.textContent = formatTime(time);
  seekPreview.style.left = `${ratio * rect.width}px`;
  seekPreview.hidden = false;

  if (media.thumbCount && media.thumbInterval) {
    const idx = Math.min(media.thumbCount - 1, Math.max(0, Math.floor(time / media.thumbInterval)));
    if (seekPreviewImg.dataset.idx !== String(idx)) {
      seekPreviewImg.dataset.idx = String(idx);
      seekPreviewImg.src = `/thumb?room=${encodeURIComponent(roomToken)}&v=${media.version}&i=${idx}`;
    }
    seekPreviewImg.hidden = false;
  } else {
    seekPreviewImg.hidden = true;
  }
});
seekWrap.addEventListener("mouseleave", () => {
  seekPreview.hidden = true;
});

// 画面 (映像) をタップ/クリックで再生・一時停止をトグル
video.addEventListener("click", () => requestPlayPause());

// 矢印キーで10秒スキップ (入力欄にフォーカス中は無視)
window.addEventListener("keydown", (e) => {
  if (appEl.hidden) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "ArrowRight") {
    e.preventDefault();
    requestSkip(10);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    requestSkip(-10);
  }
});

guestControlToggle.addEventListener("change", () => {
  if (!isHost) return;
  socket?.send({ type: "setGuestControl", enabled: guestControlToggle.checked });
});

clickToPlay.addEventListener("click", () => {
  void video.play();
  clickToPlay.hidden = true;
});

volumeBar.addEventListener("input", () => {
  video.volume = Number(volumeBar.value) / 100;
});

fullscreenBtn.addEventListener("click", () => {
  const wrap = video.parentElement!;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void wrap.requestFullscreen();
});

video.addEventListener("waiting", () => (buffering = true));
video.addEventListener("playing", () => (buffering = false));
video.addEventListener("canplay", () => (buffering = false));

function formatTime(sec: number): string {
  if (!Number.isFinite(sec)) return "0:00";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

function updateTimeUi(): void {
  const duration = media?.duration ?? 0;
  if (seekDragging && duration > 0) {
    const preview = (Number(seekBar.value) / 1000) * duration;
    timeLabel.textContent = `${formatTime(preview)} / ${formatTime(duration)}`;
    return;
  }
  timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(duration)}`;
  if (duration > 0) seekBar.value = String(Math.round((video.currentTime / duration) * 1000));

  const drift = engine.driftMs();
  if (drift == null || media?.status !== "ready") {
    driftLabel.textContent = "";
  } else {
    driftLabel.textContent = `ズレ ${drift > 0 ? "+" : ""}${drift}ms`;
    driftLabel.classList.toggle("bad", Math.abs(drift) > 300);
  }
}
setInterval(updateTimeUi, 500);

// ---- 参加者リスト ----

function renderParticipants(list: Participant[]): void {
  participantsList.replaceChildren(
    ...list.map((p) => {
      const li = document.createElement("li");
      const status = p.buffering ? "⏳" : p.ready ? "🟢" : "⚪";
      const drift = p.driftMs != null ? `${p.driftMs > 0 ? "+" : ""}${p.driftMs}ms` : "";
      li.textContent = `${status} ${p.name}${p.isHost ? " 👑" : ""}${p.id === selfId ? " (自分)" : ""} ${drift}`;
      return li;
    }),
  );
}

// ---- 共有URL ----

function applyTunnel(tunnelUrl: string | null, shareUrl: string): void {
  shareUrlInput.value = shareUrl;
  tunnelNote.hidden = tunnelUrl != null;
}

copyBtn.addEventListener("click", () => {
  void navigator.clipboard.writeText(shareUrlInput.value).then(() => {
    copyBtn.textContent = "✅";
    setTimeout(() => (copyBtn.textContent = "📋"), 1500);
  });
});

// ---- ホスト: ファイル選択 ----

async function loadFileList(): Promise<void> {
  if (!roomToken || !hostKey) return;
  fileList.replaceChildren();
  try {
    const res = await fetch(`/api/files?room=${encodeURIComponent(roomToken)}&host=${encodeURIComponent(hostKey)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: { mediaDir: string; files: MediaFileEntry[] } = await res.json();
    mediaDirLabel.textContent = data.mediaDir;
    if (data.files.length === 0) {
      const li = document.createElement("li");
      li.className = "note";
      li.textContent = "動画ファイルが見つかりません";
      fileList.append(li);
      return;
    }
    for (const f of data.files) {
      const li = document.createElement("li");
      const sizeGb = f.size / 1024 ** 3;
      const size = sizeGb >= 1 ? `${sizeGb.toFixed(1)}GB` : `${(f.size / 1024 ** 2).toFixed(0)}MB`;
      li.textContent = `${f.name} (${size})`;
      li.title = f.path;
      li.addEventListener("click", () => socket?.send({ type: "selectMedia", path: f.path }));
      fileList.append(li);
    }
  } catch (e) {
    mediaDirLabel.textContent = `一覧の取得に失敗: ${e}`;
  }
}

refreshFilesBtn.addEventListener("click", () => void loadFileList());
pathBtn.addEventListener("click", () => {
  const p = pathInput.value.trim().replace(/^"|"$/g, "");
  if (p) socket?.send({ type: "selectMedia", path: p });
});
pathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") pathBtn.click();
});
