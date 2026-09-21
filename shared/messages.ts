// サーバー・クライアント共通の型定義

export interface PlaybackState {
  /** 一時停止中か */
  paused: boolean;
  /** updatedAt 時点の再生位置 (秒) */
  position: number;
  /** サーバー時刻 (epoch ms)。再生中なら現在位置 = position + (サーバー現在時刻 - updatedAt) / 1000 */
  updatedAt: number;
}

export type MediaStatus = "none" | "probing" | "converting" | "ready" | "error";

/** 映像の供給元。file = ホストPCのファイル配信 / youtube = 各自のブラウザがYouTubeから直接再生 */
export type MediaKind = "file" | "youtube";

export interface MediaInfo {
  status: MediaStatus;
  kind: MediaKind;
  /** kind === "youtube" のときの動画ID */
  youtubeId: string | null;
  /** 表示用ファイル名 */
  fileName: string | null;
  /** 動画の長さ (秒) */
  duration: number | null;
  /** 変換進捗 0-100 (converting のときのみ) */
  progress: number | null;
  error: string | null;
  /** メディアが切り替わるたびに増える。<video> の src キャッシュバスターに使う */
  version: number;
  /** 変換なしで配信しているか */
  direct: boolean;
  /** サムネイルの間隔 (秒)。未生成なら null */
  thumbInterval: number | null;
  /** 生成済みサムネイル枚数。未生成なら null */
  thumbCount: number | null;
}

export interface Participant {
  id: string;
  name: string;
  isHost: boolean;
  /** サーバー期待位置との差 (ms)。+なら進んでいる */
  driftMs: number | null;
  buffering: boolean;
  /** 再生可能な程度にバッファ済みか */
  ready: boolean;
}

export interface MediaFileEntry {
  /** メディアフォルダからの相対パス (表示用) */
  name: string;
  /** 絶対パス (selectMedia に渡す) */
  path: string;
  /** バイト数 */
  size: number;
}

export type ClientMessage =
  | { type: "ping"; t0: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; position: number }
  | { type: "selectMedia"; path: string }
  | { type: "selectYoutube"; url: string }
  /** YouTube は長さをサーバー側で知れないため、ホストのプレイヤーが判明時に報告する */
  | { type: "reportDuration"; version: number; duration: number }
  | { type: "setGuestControl"; enabled: boolean }
  | { type: "status"; driftMs: number | null; buffering: boolean; ready: boolean };

export type ServerMessage =
  | {
      type: "welcome";
      selfId: string;
      isHost: boolean;
      allowGuestControl: boolean;
      media: MediaInfo;
      playback: PlaybackState;
      participants: Participant[];
      serverTime: number;
      tunnelUrl: string | null;
      shareUrl: string;
    }
  | { type: "pong"; t0: number; serverTime: number }
  | { type: "media"; media: MediaInfo }
  | { type: "playback"; playback: PlaybackState }
  | { type: "participants"; participants: Participant[] }
  | { type: "tunnel"; tunnelUrl: string | null; shareUrl: string }
  | { type: "settings"; allowGuestControl: boolean }
  | { type: "error"; message: string };
