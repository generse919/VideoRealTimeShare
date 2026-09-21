import { spawn, type ChildProcess } from "node:child_process";
import dns from "node:dns/promises";
import { config } from "./config.ts";

/** 起動中のトンネル */
interface ActiveTunnel {
  url: string;
  stop: () => void;
}

/** 公開URLが発行されるのを待つ最大時間 (ms) */
const START_TIMEOUT = 25_000;
/**
 * 発行されたURLが名前解決できるようになるまで待つ最大時間 (ms)。
 * cloudflared 自身が「到達可能になるまで時間がかかることがある」と表示するとおり、
 * クイックトンネルのDNS反映には数十秒かかることがある。ここを短くすると、
 * 本来使えるはずの cloudflared を見切って localtunnel に落ちてしまう。
 */
const DNS_WAIT_TIMEOUT = 60_000;

/**
 * ホスト名が名前解決できるようになるまで待つ。
 *
 * トンネル業者はURLを割り当てた直後に出力するが、その時点ではまだDNSに
 * 反映されていないことがある。反映前にブラウザで開くと DNS_PROBE_POSSIBLE で
 * 失敗し、しかもブラウザがその失敗をキャッシュするため、反映後も繋がらなくなる。
 *
 * さらに、環境によっては特定の業者のドメインが恒久的に引けないことがある
 * (家庭用ルーターのDNSが trycloudflare.com にIPv6しか返さない等)。
 * その場合はここで失格と判断し、呼び出し側が別の業者へ切り替える。
 */
async function waitForDns(hostname: string): Promise<boolean> {
  const deadline = Date.now() + DNS_WAIT_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      // ブラウザが実際に使うIPv4アドレスが引けることまで確認する
      const addresses = await dns.resolve4(hostname);
      if (addresses.length > 0) return true;
    } catch {
      /* まだ反映されていない */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** 子プロセスの出力にURLが現れるのを待つ、CLI系の業者に共通の処理 */
function startFromCli(exePath: string, args: string[], pattern: RegExp, label: string): Promise<ActiveTunnel | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(exePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve(null);
    }

    let settled = false;
    const finish = (result: ActiveTunnel | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result) proc.kill();
      resolve(result);
    };
    const timer = setTimeout(() => {
      console.warn(`[tunnel] ${label}: URLが発行されませんでした (タイムアウト)`);
      finish(null);
    }, START_TIMEOUT);

    const scan = (chunk: Buffer) => {
      const m = String(chunk).match(pattern);
      if (m) finish({ url: m[0], stop: () => proc.kill() });
    };
    proc.stdout?.on("data", scan);
    proc.stderr?.on("data", scan);
    proc.on("error", (e) => {
      console.warn(`[tunnel] ${label}: 起動に失敗しました: ${e}`);
      finish(null);
    });
    proc.on("close", (code) => {
      if (!settled) console.warn(`[tunnel] ${label}: 終了しました (exit ${code})`);
      finish(null);
    });
    process.on("exit", () => proc.kill());
  });
}

/** Cloudflare のクイックトンネル。アカウント不要だが cloudflared の導入が必要 */
function startCloudflared(port: number): Promise<ActiveTunnel | null> {
  if (!config.cloudflaredPath) {
    console.warn("[tunnel] cloudflared が見つかりません (`winget install Cloudflare.cloudflared` で導入できます)。");
    return Promise.resolve(null);
  }
  return startFromCli(
    config.cloudflaredPath,
    ["tunnel", "--url", `http://localhost:${port}`],
    /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
    "cloudflared",
  );
}

/**
 * localtunnel。アカウントも外部コマンドも不要なので、
 * cloudflared が使えない環境での自動フォールバック先にしている。
 */
async function startLocaltunnel(port: number): Promise<ActiveTunnel | null> {
  try {
    const mod: any = await import("localtunnel");
    const localtunnel = mod.default ?? mod;
    const tunnel = await localtunnel({ port });
    if (typeof tunnel?.url !== "string") {
      tunnel?.close?.();
      return null;
    }
    process.on("exit", () => tunnel.close());
    return { url: tunnel.url, stop: () => tunnel.close() };
  } catch (e) {
    console.warn(`[tunnel] localtunnel: 起動に失敗しました: ${e}`);
    return null;
  }
}

/** ngrok。無料でも認証トークンの設定が必要なため、明示的に選んだときだけ使う */
function startNgrok(port: number): Promise<ActiveTunnel | null> {
  if (!config.ngrokPath) {
    console.warn("[tunnel] ngrok が見つかりません (`winget install ngrok.ngrok` で導入できます)。");
    return Promise.resolve(null);
  }
  return startFromCli(
    config.ngrokPath,
    ["http", String(port), "--log", "stdout", "--log-format", "logfmt"],
    /https:\/\/[a-z0-9-]+\.ngrok[a-z0-9.-]*\.(?:app|io|dev)/,
    "ngrok",
  );
}

const PROVIDERS = {
  cloudflared: startCloudflared,
  localtunnel: startLocaltunnel,
  ngrok: startNgrok,
} as const;

export type TunnelProvider = keyof typeof PROVIDERS;

/**
 * 優先する方法を諦めるまでの試行回数。
 * cloudflared は一時的にURLの発行に失敗することがあり、1回で見切ると
 * 確認ページを挟む localtunnel に不必要に落ちてしまうため、もう一度試す。
 */
const PREFERRED_ATTEMPTS = 2;

/** 試す業者の順番。VRT_TUNNEL で1つに固定できる */
function providerOrder(): TunnelProvider[] {
  const requested = (process.env.VRT_TUNNEL ?? "").trim().toLowerCase();
  if (requested in PROVIDERS) return [requested as TunnelProvider];
  if (requested) console.warn(`[tunnel] VRT_TUNNEL=${requested} は不明な指定です。自動選択を使います。`);

  if (!config.cloudflaredPath) {
    // 未導入なら並べるだけ無駄 (同じ警告を試行回数ぶん繰り返すことにもなる)
    console.warn(
      "[tunnel] cloudflared が見つかりません (`winget install Cloudflare.cloudflared` で導入できます)。localtunnel を使います。",
    );
    return ["localtunnel"];
  }
  // cloudflared を優先し、それが使えない環境でだけ localtunnel へ切り替える
  return [...Array<TunnelProvider>(PREFERRED_ATTEMPTS).fill("cloudflared"), "localtunnel"];
}

/**
 * localtunnel は初回アクセス時に確認ページを挟み、ホストのグローバルIPアドレスの
 * 入力を求める。ゲストが詰まらないよう、その値を起動時に取得して表示しておく。
 */
async function printLocaltunnelHint(): Promise<void> {
  let password = "(https://loca.lt/mytunnelpassword を開くと確認できます)";
  try {
    const res = await fetch("https://loca.lt/mytunnelpassword", { signal: AbortSignal.timeout(5000) });
    if (res.ok) password = (await res.text()).trim();
  } catch {
    /* 取得できなくても致命的ではない */
  }
  console.log("[tunnel] localtunnel は初回アクセス時に確認ページを表示します。");
  console.log(`[tunnel] そこで入力するパスワード: ${password}  (ゲストにも伝えてください)`);
}

/** 公開URLを報告して、必要ならlocaltunnelの注意書きも出す */
async function report(name: TunnelProvider, url: string, onUrl: (url: string | null) => void): Promise<void> {
  console.log(`[tunnel] 公開URL (${name}): ${url}`);
  if (name === "localtunnel") {
    // 同時接続数が少なく、動画ファイルの配信には耐えられない。
    // YouTube共有なら映像がここを通らないので問題なく使える。
    console.warn("[tunnel] 注意: localtunnel はパソコン内の動画ファイルの配信には向きません (502 になることがあります)。");
    console.warn("[tunnel] 　　　 YouTubeの共有であれば映像がこのトンネルを通らないため問題ありません。");
    console.warn("[tunnel] 　　　 動画ファイルを共有したい場合は cloudflared を使ってください (`VRT_TUNNEL=cloudflared` で固定できます)。");
    await printLocaltunnelHint();
  }
  onUrl(url);
}

/**
 * 公開トンネルを起動し、発行された公開URLを報告する。
 * どの方法も使えなければ null を報告してローカルURLのみで続行する。
 */
export function startTunnel(onUrl: (url: string | null) => void): void {
  if (config.disableTunnel) {
    onUrl(null);
    return;
  }

  void (async () => {
    const order = providerOrder();
    // URLは発行できたのに名前解決できなかった業者。同じドメインを引き直しても
    // 結果は変わらないので、その業者の残りの試行は飛ばす
    const unresolvable = new Set<TunnelProvider>();

    for (let i = 0; i < order.length; i++) {
      const name = order[i];
      if (unresolvable.has(name)) continue;
      if (i > 0 && name === order[i - 1]) console.log(`[tunnel] ${name} をもう一度試します...`);

      const started = await PROVIDERS[name](config.port);
      if (!started) continue;

      const hostname = new URL(started.url).hostname;
      if (await waitForDns(hostname)) {
        await report(name, started.url, onUrl);
        return;
      }

      unresolvable.add(name);
      if (order.slice(i + 1).some((next) => !unresolvable.has(next))) {
        // この環境からは引けないURLなので、配らずに別の業者へ切り替える
        console.warn(`[tunnel] ${name} のURL (${hostname}) をこの環境から名前解決できません。別の方法を試します。`);
        started.stop();
        continue;
      }

      // 他に手が無いときは、確認できなくてもURLは捨てない。
      // この環境から引けないだけで、実際には繋がることがあるため。
      console.warn(`[tunnel] ${hostname} の名前解決を確認できませんでした。繋がらない場合は少し待ってから再読み込みしてください。`);
      await report(name, started.url, onUrl);
      return;
    }

    console.warn("[tunnel] 公開URLを作成できませんでした。同じLAN内であればローカルURLで参加できます。");
    onUrl(null);
  })();
}
