/**
 * 同期エンジンから見たプレイヤーの共通インターフェース。
 * ローカルファイル用の <video> と、YouTube の IFrame プレイヤーの
 * 差異をここで吸収する。
 */
export interface PlayerAdapter {
  /** 位置の取得・変更ができる状態か */
  isReady(): boolean;
  /** 途切れず再生できる程度にバッファ済みか (参加者リストの表示用) */
  isBuffered(): boolean;
  currentTime(): number;
  /** 不明なら Infinity */
  duration(): number;
  isPaused(): boolean;
  /** シーク処理中 (この間は補正しない) */
  isSeeking(): boolean;
  seek(sec: number): void;
  /** 自動再生がブロックされた場合は reject する */
  play(): Promise<void>;
  pause(): void;
  setRate(rate: number): void;
  /** 音量 0..1 */
  setVolume(volume: number): void;
  /**
   * playbackRate を任意の倍率に設定できるか。
   * true ならズレを ±5% の速度調整で滑らかに吸収し、
   * false (YouTube) なら離散値しか使えないためシークで合わせる。
   */
  readonly fineRate: boolean;
}

/** ローカル配信ファイル用 (<video> 要素) */
export class VideoElementPlayer implements PlayerAdapter {
  readonly fineRate = true;

  constructor(private video: HTMLVideoElement) {}

  isReady(): boolean {
    return this.video.readyState > 0;
  }
  isBuffered(): boolean {
    return this.video.readyState >= 3;
  }
  currentTime(): number {
    return this.video.currentTime;
  }
  duration(): number {
    return Number.isFinite(this.video.duration) ? this.video.duration : Infinity;
  }
  isPaused(): boolean {
    return this.video.paused;
  }
  isSeeking(): boolean {
    return this.video.seeking;
  }
  seek(sec: number): void {
    this.video.currentTime = sec;
  }
  play(): Promise<void> {
    return this.video.play();
  }
  pause(): void {
    this.video.pause();
  }
  setRate(rate: number): void {
    this.video.playbackRate = rate;
  }
  setVolume(volume: number): void {
    this.video.volume = volume;
  }
}

// ---- YouTube IFrame Player API ----
//
// 公式プレイヤーをそのまま埋め込み、各視聴者のブラウザが YouTube から
// 直接動画を受信する (サーバーは映像を中継しない)。同期するのは再生位置だけ。

/** https://developers.google.com/youtube/iframe_api_reference の必要部分のみ */
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setVolume(volume: number): void;
  setPlaybackRate(rate: number): void;
  getAvailablePlaybackRates(): number[];
  loadVideoById(videoId: string): void;
  destroy(): void;
}

const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

/** 埋め込みが拒否された等のエラーコードを日本語にする */
function youtubeErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return "動画IDが不正です";
    case 5:
      return "この動画はブラウザ内蔵プレイヤーで再生できません";
    case 100:
      return "動画が見つかりません (削除済み / 非公開)";
    case 101:
    case 150:
      return "この動画は埋め込み再生が許可されていません。YouTubeで直接開く必要があります";
    default:
      return `YouTubeプレイヤーのエラー (コード ${code})`;
  }
}

let apiLoading: Promise<void> | null = null;

/** IFrame Player API のスクリプトを一度だけ読み込む */
function loadYoutubeApi(): Promise<void> {
  if (apiLoading) return apiLoading;
  apiLoading = new Promise<void>((resolve, reject) => {
    const w = window as any;
    if (w.YT?.Player) return resolve();
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => reject(new Error("YouTubeプレイヤーの読み込みに失敗しました (ネットワークを確認してください)"));
    document.head.append(script);
  });
  return apiLoading;
}

export class YoutubePlayer implements PlayerAdapter {
  /** YouTube は決められた倍率しか受け付けないため微調整はできない */
  readonly fineRate = false;

  private player: YTPlayer | null = null;
  private seekingUntil = 0;
  /** play() を要求し始めた時刻。再生が始まらないまま一定時間経つとブロック扱い */
  private playSince = 0;
  private pendingVolume: number | null = null;

  private constructor(
    private videoId: string,
    private onError: (message: string) => void,
    private onStateChange: (buffering: boolean) => void,
  ) {}

  /** コンテナ要素に YouTube プレイヤーを生成する */
  static async create(
    container: HTMLElement,
    videoId: string,
    onError: (message: string) => void,
    onStateChange: (buffering: boolean) => void,
  ): Promise<YoutubePlayer> {
    await loadYoutubeApi();
    const self = new YoutubePlayer(videoId, onError, onStateChange);
    await new Promise<void>((resolve) => {
      const YT = (window as any).YT;
      self.player = new YT.Player(container, {
        videoId,
        playerVars: {
          // 操作は必ずこのアプリ側から行う (YouTube の UI で操作されると同期が崩れるため)
          controls: 0,
          disablekb: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          fs: 0,
          origin: location.origin,
        },
        events: {
          onReady: () => {
            if (self.pendingVolume != null) self.player?.setVolume(self.pendingVolume);
            resolve();
          },
          onStateChange: (e: { data: number }) => {
            if (e.data === YT_STATE.PLAYING) self.playSince = 0;
            onStateChange(e.data === YT_STATE.BUFFERING);
          },
          onError: (e: { data: number }) => onError(youtubeErrorMessage(e.data)),
        },
      }) as YTPlayer;
    });
    return self;
  }

  /** 同じプレイヤーを使い回して別の動画に切り替える */
  load(videoId: string): void {
    this.videoId = videoId;
    this.playSince = 0;
    this.player?.loadVideoById(videoId);
  }

  private state(): number {
    return this.player?.getPlayerState() ?? YT_STATE.UNSTARTED;
  }

  isReady(): boolean {
    // UNSTARTED の間は getCurrentTime が 0 を返し続けるので同期対象にしない
    return this.player != null && this.state() !== YT_STATE.UNSTARTED;
  }
  isBuffered(): boolean {
    const s = this.state();
    return s === YT_STATE.PLAYING || s === YT_STATE.PAUSED || s === YT_STATE.CUED;
  }
  currentTime(): number {
    return this.player?.getCurrentTime() ?? 0;
  }
  duration(): number {
    const d = this.player?.getDuration() ?? 0;
    return d > 0 ? d : Infinity;
  }
  isPaused(): boolean {
    const s = this.state();
    return s !== YT_STATE.PLAYING && s !== YT_STATE.BUFFERING;
  }
  isSeeking(): boolean {
    return Date.now() < this.seekingUntil;
  }
  seek(sec: number): void {
    this.player?.seekTo(sec, true);
    // シーク直後は getCurrentTime が古い値を返すことがあるため、少しの間は補正を止める
    this.seekingUntil = Date.now() + 500;
  }
  play(): Promise<void> {
    const s = this.state();
    if (s === YT_STATE.PLAYING || s === YT_STATE.BUFFERING) {
      this.playSince = 0;
      return Promise.resolve();
    }
    if (this.playSince === 0) this.playSince = Date.now();
    this.player?.playVideo();
    // 要求し続けても再生が始まらない = ブラウザの自動再生ブロック
    return Date.now() - this.playSince > 1500
      ? Promise.reject(new Error("autoplay blocked"))
      : Promise.resolve();
  }
  pause(): void {
    this.playSince = 0;
    this.player?.pauseVideo();
  }
  setRate(rate: number): void {
    const available = this.player?.getAvailablePlaybackRates?.() ?? [1];
    const nearest = available.reduce((a, b) => (Math.abs(b - rate) < Math.abs(a - rate) ? b : a), 1);
    this.player?.setPlaybackRate(nearest);
  }
  setVolume(volume: number): void {
    this.pendingVolume = Math.round(volume * 100);
    this.player?.setVolume(this.pendingVolume);
  }

  destroy(): void {
    this.player?.destroy();
    this.player = null;
  }

  /** 自動再生ブロック解除用: ユーザー操作の中から直接呼ぶ */
  forcePlay(): void {
    this.playSince = 0;
    this.player?.playVideo();
  }

  videoUrl(): string {
    return `https://www.youtube.com/watch?v=${this.videoId}`;
  }
}
