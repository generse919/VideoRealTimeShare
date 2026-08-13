// 配布用ランチャー。ffmpeg/cloudflared の有無を確認し、無ければ自動インストールを試みてから
// 本体サーバーを起動する。cmd.exe のバッチファイルは日本語テキストの扱いが不安定なため、
// ユーザー向けメッセージはすべてここ (Node.js の UTF-8 console.log) に集約している。
import { spawnSync } from "node:child_process";

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

console.log("============================================");
console.log("  VideoRealTime を起動します");
console.log("============================================");
console.log();

function has(cmd) {
  const result = isWin ? spawnSync("where", [cmd], { stdio: "ignore" }) : spawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" });
  return result.status === 0;
}

function tryAutoInstall(cmd, wingetId, brewName) {
  if (has(cmd)) return;
  if (isWin && has("winget")) {
    console.log(`${cmd} が見つからないため、インストールします (初回のみ)...`);
    spawnSync("winget", ["install", "--id", wingetId, "-e", "--accept-source-agreements", "--accept-package-agreements"], {
      stdio: "ignore",
    });
  } else if (isMac && has("brew")) {
    console.log(`${cmd} が見つからないため、インストールします (初回のみ、数分かかる場合があります)...`);
    spawnSync("brew", ["install", brewName], { stdio: "inherit" });
  }
}

tryAutoInstall("ffmpeg", "Gyan.FFmpeg", "ffmpeg");
if (!has("ffmpeg")) {
  console.log("[注意] ffmpeg が見つかりません。MKV 等の動画は変換できません。");
  console.log(isWin ? "  手動インストール: winget install --id Gyan.FFmpeg" : "  手動インストール: brew install ffmpeg");
}

tryAutoInstall("cloudflared", "Cloudflare.cloudflared", "cloudflared");
if (!has("cloudflared")) {
  console.log("[情報] cloudflared が見つかりません。遠隔地の友人と共有するには必要です。");
  console.log(
    isWin ? "  手動インストール: winget install --id Cloudflare.cloudflared" : "  手動インストール: brew install cloudflared",
  );
  console.log("  (同じWi-Fi内だけで使う場合は不要です)");
}

console.log();
console.log("サーバーを起動しています。準備ができると自動でブラウザが開きます。");
console.log("終了するにはこのウィンドウを閉じるか Ctrl+C を押してください。");
console.log();

await import("./server.mjs");
