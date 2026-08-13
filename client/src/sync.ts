import type { PlaybackState } from "../../shared/messages.ts";

/**
 * NTP 方式のクロック同期。ping/pong の往復からサーバーとの時計オフセットを推定する。
 * RTT が小さいサンプルほど正確なので、RTT 下位半分の平均を使う。
 */
export class ClockSync {
  private samples: { offset: number; rtt: number }[] = [];
  offset = 0; // serverTime - clientTime (ms)
  rtt: number | null = null;

  addSample(t0: number, serverTime: number): void {
    const t1 = Date.now();
    const rtt = t1 - t0;
    this.samples.push({ offset: serverTime - (t0 + t1) / 2, rtt });
    if (this.samples.length > 10) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
    this.offset = best.reduce((s, x) => s + x.offset, 0) / best.length;
    this.rtt = sorted[0].rtt;
  }

  serverNow(): number {
    return Date.now() + this.offset;
  }
}

/** ズレがこの範囲内なら何もしない (秒) */
const DEADBAND = 0.05;
/** これを超えたら直接シークする (秒) */
const HARD_SEEK = 1.0;
/** playbackRate の補正量 (±5%は視聴していて気づかないレベル) */
const RATE_NUDGE = 0.05;

/**
 * サーバーの権威的な再生状態に <video> を追従させるエンジン。
 * 小さなズレは playbackRate で滑らかに吸収し、大きなズレのみシークする。
 */
export class SyncEngine {
  private playback: PlaybackState | null = null;
  private timer: number | null = null;

  constructor(
    private video: HTMLVideoElement,
    private clock: ClockSync,
    private onAutoplayBlocked: (blocked: boolean) => void,
  ) {}

  setState(playback: PlaybackState): void {
    this.playback = playback;
    this.tick();
  }

  start(): void {
    if (this.timer == null) this.timer = window.setInterval(() => this.tick(), 250);
  }

  /** サーバー状態から計算した「今あるべき再生位置」(秒) */
  expectedPosition(): number | null {
    if (!this.playback) return null;
    if (this.playback.paused) return this.playback.position;
    const duration = Number.isFinite(this.video.duration) ? this.video.duration : Infinity;
    return Math.min(
      this.playback.position + (this.clock.serverNow() - this.playback.updatedAt) / 1000,
      duration,
    );
  }

  /** 現在のズレ (ms)。+なら進んでいる。状態が無いときは null */
  driftMs(): number | null {
    const expected = this.expectedPosition();
    if (expected == null || this.video.readyState === 0) return null;
    return Math.round((this.video.currentTime - expected) * 1000);
  }

  private tick(): void {
    const video = this.video;
    const playback = this.playback;
    if (!playback || video.readyState === 0) return;

    if (playback.paused) {
      if (!video.paused) video.pause();
      video.playbackRate = 1;
      if (Math.abs(video.currentTime - playback.position) > 0.1) {
        video.currentTime = playback.position;
      }
      this.onAutoplayBlocked(false);
      return;
    }

    const expected = this.expectedPosition();
    if (expected == null) return;

    if (video.paused) {
      if (!video.seeking && Math.abs(video.currentTime - expected) > DEADBAND) {
        video.currentTime = expected;
      }
      video.play().then(
        () => this.onAutoplayBlocked(false),
        () => this.onAutoplayBlocked(true), // 自動再生ブロック → クリック待ちUIを出す
      );
      return;
    }

    if (video.seeking) return;
    const drift = video.currentTime - expected;
    if (Math.abs(drift) > HARD_SEEK) {
      video.currentTime = expected + 0.05; // シーク処理分をわずかに先読み
      video.playbackRate = 1;
    } else if (Math.abs(drift) > DEADBAND) {
      video.playbackRate = drift > 0 ? 1 - RATE_NUDGE : 1 + RATE_NUDGE;
    } else {
      video.playbackRate = 1;
    }
  }
}
