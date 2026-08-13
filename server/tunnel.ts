import { spawn } from "node:child_process";
import { config } from "./config.ts";

/**
 * cloudflared のクイックトンネルを起動し、発行された公開URLを返す。
 * 未インストールなら null を報告してローカルURLのみで続行する。
 */
export function startTunnel(onUrl: (url: string | null) => void): void {
  if (config.disableTunnel) {
    onUrl(null);
    return;
  }
  if (!config.cloudflaredPath) {
    console.warn(
      "[tunnel] cloudflared が見つかりません。リモート公開するには `winget install Cloudflare.cloudflared` でインストールしてください" +
        " (インストール直後の場合は、ターミナルを開き直すとPATHが反映されます)。",
    );
    onUrl(null);
    return;
  }
  let reported = false;
  let proc;
  try {
    proc = spawn(config.cloudflaredPath, ["tunnel", "--url", `http://localhost:${config.port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    onUrl(null);
    return;
  }

  const scan = (chunk: Buffer) => {
    if (reported) return;
    const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      reported = true;
      console.log(`[tunnel] 公開URL: ${m[0]}`);
      onUrl(m[0]);
    }
  };
  proc.stdout.on("data", scan);
  proc.stderr.on("data", scan);
  proc.on("error", (e) => {
    console.warn(`[tunnel] cloudflared の起動に失敗しました: ${e}`);
    if (!reported) onUrl(null);
  });
  proc.on("close", (code) => {
    if (!reported) {
      console.warn(`[tunnel] cloudflared が終了しました (exit ${code})`);
      onUrl(null);
    }
  });
  process.on("exit", () => proc.kill());
}
