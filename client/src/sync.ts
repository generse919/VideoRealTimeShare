import type { PlaybackState } from "../../shared/messages.ts";
import type { PlayerAdapter } from "./player.ts";


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
 * 速度の微調整ができないプレイヤー (YouTube) 用のしきい値。
 * 補正手段がシークしかなく、シークのたびに再バッファが入って
 * 目に見える引っかかりになるため、許容するズレを大きめに取る。
 */
const COARSE_DEADBAND = 0.5;
/** シークによる補正の最短間隔 (ms)。シーク連発でガタつくのを防ぐ */
const COARSE_SEEK_COOLDOWN = 2000;

/**
 * サーバーの権威的な再生状態にプレイヤーを追従させるエンジン。
 * 小さなズレは playbackRate で滑らかに吸収し、大きなズレのみシークする
 * (速度調整ができないプレイヤーでは常にシークで合わせる)。
 */
export class SyncEngine {
  private playback: PlaybackState | null = null;
  private timer: number | null = null;
  private lastCoarseSeek = 0;

  constructor(
    private player: PlayerAdapter,
    private clock: ClockSync,
    private onAutoplayBlocked: (blocked: boolean) => void,
  ) {}

  /** 追従先のプレイヤーを差し替える (ファイル <-> YouTube の切り替え) */
  setPlayer(player: PlayerAdapter): void {
    this.player.setRate(1);
    this.player = player;
    this.lastCoarseSeek = 0;
    this.tick();
  }

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
    return Math.min(
      this.playback.position + (this.clock.serverNow() - this.playback.updatedAt) / 1000,
      this.player.duration(),
    );
  }

  /** 現在のズレ (ms)。+なら進んでいる。状態が無いときは null */
  driftMs(): number | null {
    const expected = this.expectedPosition();
    if (expected == null || !this.player.isReady()) return null;
    return Math.round((this.player.currentTime() - expected) * 1000);
  }

  private tick(): void {
    const player = this.player;
    const playback = this.playback;
    if (!playback || !player.isReady()) return;

    if (playback.paused) {
      if (!player.isPaused()) player.pause();
      player.setRate(1);
      if (Math.abs(player.currentTime() - playback.position) > 0.1) {
        player.seek(playback.position);
      }
      this.onAutoplayBlocked(false);
      return;
    }

    const expected = this.expectedPosition();
    if (expected == null) return;

    if (player.isPaused()) {
      if (!player.isSeeking() && Math.abs(player.currentTime() - expected) > DEADBAND) {
        player.seek(expected);
      }
      player.play().then(
        () => this.onAutoplayBlocked(false),
        () => this.onAutoplayBlocked(true), // 自動再生ブロック → クリック待ちUIを出す
      );
      return;
    }

    if (player.isSeeking()) return;
    const drift = player.currentTime() - expected;

    if (!player.fineRate) {
      // シークでしか直せないので、無視できないズレのときだけ・間隔を空けて合わせる
      if (Math.abs(drift) > COARSE_DEADBAND && Date.now() - this.lastCoarseSeek > COARSE_SEEK_COOLDOWN) {
        this.lastCoarseSeek = Date.now();
        player.seek(expected + 0.3); // シーク後の再バッファ分を見込んで少し先へ
      }
      return;
    }

    if (Math.abs(drift) > HARD_SEEK) {
      player.seek(expected + 0.05); // シーク処理分をわずかに先読み
      player.setRate(1);
    } else if (Math.abs(drift) > DEADBAND) {
      player.setRate(drift > 0 ? 1 - RATE_NUDGE : 1 + RATE_NUDGE);
    } else {
      player.setRate(1);
    }
  }
}
