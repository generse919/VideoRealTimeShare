// 配布用ランチャー。ffmpeg/cloudflared の有無を確認し、無ければ自動インストールを試みてから
// 本体サーバーを起動する。cmd.exe のバッチファイルは日本語テキストの扱いが不安定なため、
// ユーザー向けメッセージはすべてここ (Node.js の UTF-8 console.log) に集約している。
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";

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

/** はい/いいえを尋ねる。対話できない環境では「いいえ」扱いにする */
async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} (y/N): `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

/**
 * 不足しているソフトを、本人の同意を得てからインストールする。
 * 他者が作ったソフトの使用許諾への同意を、こちらが黙って代行するべきではないため、
 * 提供元を示したうえで明示的に確認する。
 */
async function tryAutoInstall(cmd, wingetId, brewName, homepage) {
  if (has(cmd)) return;
  const canInstall = (isWin && has("winget")) || (isMac && has("brew"));
  if (!canInstall) return;

  console.log();
  console.log(`${cmd} が見つかりません。自動でインストールできます (初回のみ)。`);
  console.log(`  提供元・ライセンス: ${homepage}`);
  console.log("  続行すると、そのソフトウェアの使用許諾に同意したものとして扱われます。");
  if (!(await confirm("  インストールしますか？"))) {
    console.log("  スキップしました。");
    return;
  }

  console.log(`  ${cmd} をインストールしています (数分かかる場合があります)...`);
  if (isWin) {
    spawnSync("winget", ["install", "--id", wingetId, "-e", "--accept-source-agreements", "--accept-package-agreements"], {
      stdio: "ignore",
    });
  } else {
    spawnSync("brew", ["install", brewName], { stdio: "inherit" });
  }
}

await tryAutoInstall("ffmpeg", "Gyan.FFmpeg", "ffmpeg", "https://ffmpeg.org/legal.html");
if (!has("ffmpeg")) {
  console.log("[注意] ffmpeg が見つかりません。MKV 等の動画は変換できません。");
  console.log(isWin ? "  手動インストール: winget install --id Gyan.FFmpeg" : "  手動インストール: brew install ffmpeg");
}

await tryAutoInstall(
  "cloudflared",
  "Cloudflare.cloudflared",
  "cloudflared",
  "https://github.com/cloudflare/cloudflared/blob/master/LICENSE",
);
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
