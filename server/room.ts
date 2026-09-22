import crypto from "node:crypto";
import path from "node:path";
import type { WebSocket } from "ws";
import type {
  ClientMessage,
  MediaInfo,
  Participant,
  PlaybackState,
  ServerMessage,
} from "../shared/messages.ts";
import { config } from "./config.ts";
import { MediaManager, parseYoutubeId } from "./media.ts";

interface Member {
  ws: WebSocket;
  participant: Participant;
}

/**
 * 同時に参加できる人数の上限。
 *
 * 「友人と一緒に見る」用途に限定するための上限であり、単なる性能上の都合ではない。
 * 不特定多数へ配信する装置になってしまうと、著作物を扱う際の位置づけが変わるため、
 * 設計として「特定かつ少数」に収まることを担保している。
 */
const MAX_PARTICIPANTS = 4;

/** 満員で入れなかったことを示すWebSocketのクローズコード (再接続させないために使う) */
export const CLOSE_ROOM_FULL = 4001;

/**
 * ルームの権威的状態。
 * 再生位置はイベント時刻とセットで保持し、クライアント側が
 * 「position + 経過時間」で現在位置を復元する。
 */
export class Room {
  playback: PlaybackState = { paused: true, position: 0, updatedAt: Date.now() };
  media: MediaManager;

  private members = new Map<string, Member>();
  private participantsDirty = false;
  private lastMediaVersion = 0;
  private guestControlEnabled = false;
  private getTunnelInfo: () => { tunnelUrl: string | null; shareUrl: string };

  constructor(getTunnelInfo: () => { tunnelUrl: string | null; shareUrl: string }) {
    this.getTunnelInfo = getTunnelInfo;
    this.media = new MediaManager((info) => this.onMediaUpdate(info));

    // 定期リブロードキャストでドリフトを抑える。参加者リストは変更があったときだけ流す
    setInterval(() => {
      if (this.members.size === 0) return;
      this.broadcast({ type: "playback", playback: this.playback });
    }, 3000);
    setInterval(() => {
      if (this.participantsDirty) {
        this.participantsDirty = false;
        this.broadcastParticipants();
      }
    }, 1000);
  }

  /** 現在の再生位置 (秒) をサーバー時刻から計算 */
  private currentPosition(now = Date.now()): number {
    if (this.playback.paused) return this.playback.position;
    const pos = this.playback.position + (now - this.playback.updatedAt) / 1000;
    const dur = this.media.info.duration;
    return dur != null ? Math.min(pos, dur) : pos;
  }

  private clampPosition(pos: number): number {
    const dur = this.media.info.duration;
    return Math.max(0, dur != null ? Math.min(pos, dur) : pos);
  }

  private canControl(participant: Participant): boolean {
    return participant.isHost || this.guestControlEnabled;
  }

  join(ws: WebSocket, name: string, isHost: boolean): void {
    // ホストは常に入れる (再接続できなくなると誰も操作できなくなるため)
    if (!isHost && this.members.size >= MAX_PARTICIPANTS) {
      this.send(ws, { type: "error", message: `満員です (最大${MAX_PARTICIPANTS}人)` });
      ws.close(CLOSE_ROOM_FULL, "room full");
      return;
    }

    const id = crypto.randomBytes(6).toString("base64url");
    const participant: Participant = {
      id,
      name: name.slice(0, 32) || "名無し",
      isHost,
      driftMs: null,
      buffering: false,
      ready: false,
    };
    this.members.set(id, { ws, participant });

    const { tunnelUrl, shareUrl } = this.getTunnelInfo();
    this.send(ws, {
      type: "welcome",
      selfId: id,
      isHost,
      allowGuestControl: this.guestControlEnabled,
      media: this.media.info,
      playback: this.playback,
      participants: this.participantList(),
      serverTime: Date.now(),
      tunnelUrl,
      shareUrl,
    });
    this.broadcastParticipants();

    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      this.handleMessage(id, msg);
    });
    ws.on("close", () => {
      this.members.delete(id);
      this.broadcastParticipants();
    });
  }

  notifyTunnelChanged(): void {
    const { tunnelUrl, shareUrl } = this.getTunnelInfo();
    this.broadcast({ type: "tunnel", tunnelUrl, shareUrl });
  }

  private handleMessage(id: string, msg: ClientMessage): void {
    const member = this.members.get(id);
    if (!member) return;
    const { ws, participant } = member;

    switch (msg.type) {
      case "ping":
        this.send(ws, { type: "pong", t0: msg.t0, serverTime: Date.now() });
        break;

      case "play":
      case "pause": {
        if (!this.canControl(participant)) return;
        if (this.media.info.status !== "ready") return;
        const now = Date.now();
        this.playback = {
          paused: msg.type === "pause",
          position: this.clampPosition(this.currentPosition(now)),
          updatedAt: now,
        };
        this.broadcast({ type: "playback", playback: this.playback });
        break;
      }

      case "seek": {
        if (!this.canControl(participant)) return;
        if (this.media.info.status !== "ready") return;
        this.playback = {
          paused: this.playback.paused,
          position: this.clampPosition(msg.position),
          updatedAt: Date.now(),
        };
        this.broadcast({ type: "playback", playback: this.playback });
        break;
      }

      case "selectMedia": {
        if (!participant.isHost) {
          this.send(ws, { type: "error", message: "ホストのみ操作できます" });
          return;
        }
        // メディアフォルダの外は選ばせない。
        // ホスト用URLを共有用URLと取り違えて渡してしまった場合に、
        // 受け取った相手がホストPC上の任意のファイルを読み出せてしまうため。
        const resolved = path.resolve(msg.path);
        const root = path.resolve(config.mediaDir) + path.sep;
        // Windows はパスの大文字小文字を区別しないので、比較もそれに合わせる
        const norm = (v: string) => (process.platform === "win32" ? v.toLowerCase() : v);
        if (!norm(resolved).startsWith(norm(root))) {
          this.send(ws, {
            type: "error",
            message: `メディアフォルダ (${config.mediaDir}) の外にあるファイルは選択できません`,
          });
          return;
        }
        void this.media.prepare(resolved);
        break;
      }

      case "selectYoutube": {
        if (!participant.isHost) {
          this.send(ws, { type: "error", message: "ホストのみ操作できます" });
          return;
        }
        const youtubeId = parseYoutubeId(msg.url);
        if (!youtubeId) {
          this.send(ws, { type: "error", message: "YouTubeのURLとして解釈できませんでした" });
          return;
        }
        this.media.setYoutube(youtubeId, `YouTube: ${youtubeId}`);
        break;
      }

      case "reportDuration":
        // 長さはホストのプレイヤーだけが知っているので、ホストの報告のみ受け付ける
        if (!participant.isHost) return;
        if (this.media.setReportedDuration(msg.version, msg.duration)) {
          // 長さが判明したので、それを踏まえた位置に丸めて配り直す
          const now = Date.now();
          this.playback = { ...this.playback, position: this.clampPosition(this.currentPosition(now)), updatedAt: now };
          this.broadcast({ type: "playback", playback: this.playback });
        }
        break;

      case "setGuestControl":
        if (!participant.isHost) return;
        this.guestControlEnabled = msg.enabled;
        this.broadcast({ type: "settings", allowGuestControl: this.guestControlEnabled });
        break;

      case "status":
        participant.driftMs = msg.driftMs;
        participant.buffering = msg.buffering;
        participant.ready = msg.ready;
        this.participantsDirty = true;
        break;
    }
  }

  private onMediaUpdate(info: MediaInfo): void {
    // メディアが切り替わったら先頭で一時停止に戻す。
    // version を見るのは、再生開始後に届く更新 (サムネイル生成完了・長さの報告) で
    // 再生位置が巻き戻らないようにするため。
    if (info.version !== this.lastMediaVersion) {
      this.lastMediaVersion = info.version;
      this.playback = { paused: true, position: 0, updatedAt: Date.now() };
      this.broadcast({ type: "playback", playback: this.playback });
    }
    this.broadcast({ type: "media", media: info });
  }

  private participantList(): Participant[] {
    return [...this.members.values()].map((m) => m.participant);
  }

  private broadcastParticipants(): void {
    this.broadcast({ type: "participants", participants: this.participantList() });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const { ws } of this.members.values()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }
}
