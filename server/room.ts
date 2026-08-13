import crypto from "node:crypto";
import type { WebSocket } from "ws";
import type {
  ClientMessage,
  MediaInfo,
  Participant,
  PlaybackState,
  ServerMessage,
} from "../shared/messages.ts";
import { MediaManager } from "./media.ts";

interface Member {
  ws: WebSocket;
  participant: Participant;
}

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

      case "selectMedia":
        if (!participant.isHost) {
          this.send(ws, { type: "error", message: "ホストのみ操作できます" });
          return;
        }
        void this.media.prepare(msg.path);
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
    if (info.status === "ready" || info.status === "probing") {
      // メディアが切り替わったら先頭で一時停止に戻す
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
