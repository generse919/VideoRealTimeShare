// npm/ffmpeg等の知識が無くても使えるよう、サーバーを依存関係込みの単一ファイルにバンドルし、
// Windows / Mac それぞれのダブルクリック起動フォルダをzipにまとめる。
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";
import { build } from "esbuild";
import { generateNotices } from "./generate-notices.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
// タグから実行された CI では GITHUB_REF_NAME (例: v1.2.3) を優先し、package.json とのズレを防ぐ
const version = (process.env.GITHUB_REF_NAME ?? `v${JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version}`).replace(
  /^v/,
  "",
);

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });

console.log("[1/4] クライアントをビルド中...");
execSync("npm run build", { cwd: root, stdio: "inherit" });

console.log("[2/4] サーバーを単一ファイルにバンドル中...");
const bundledServer = path.join(releaseDir, "_server.mjs");
await build({
  entryPoints: [path.join(root, "server", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: bundledServer,
  // ws の任意ネイティブ高速化モジュール (未インストールなら実行時にws自身がフォールバックする)
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
});

function assemble(platform, launcher) {
  const dir = path.join(releaseDir, platform, "VideoRealTime");
  fs.mkdirSync(path.join(dir, "server"), { recursive: true });
  fs.cpSync(bundledServer, path.join(dir, "server", "server.mjs"));
  fs.cpSync(path.join(root, "server", "launcher.mjs"), path.join(dir, "server", "launcher.mjs"));
  fs.cpSync(path.join(root, "client", "dist"), path.join(dir, "client", "dist"), { recursive: true });
  fs.cpSync(path.join(root, "README.md"), path.join(dir, "README.md"));

  // 利用条件まわりを配布物に同梱する
  for (const name of ["LICENSE", "PRIVACY.md"]) {
    const src = path.join(root, name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, name));
  }
  fs.writeFileSync(path.join(dir, "THIRD-PARTY-NOTICES.txt"), notices);
  const dest = path.join(dir, launcher.name);
  fs.cpSync(path.join(root, "scripts", launcher.name), dest);
  if (launcher.mode) fs.chmodSync(dest, launcher.mode);
  return dir;
}

// バンドルした依存ライブラリのライセンス表示 (MIT等が複製物への同梱を求めている)
const notices = generateNotices(root);

console.log("[3/4] 配布フォルダを構成中...");
const winDir = assemble("windows", { name: "start.bat" });
const macDir = assemble("mac", { name: "start.command", mode: 0o755 });

console.log("[4/4] zipを作成中...");
await Promise.all([
  zipDir(path.join(releaseDir, "windows"), path.join(releaseDir, `VideoRealTime-windows-v${version}.zip`)),
  zipDir(path.join(releaseDir, "mac"), path.join(releaseDir, `VideoRealTime-mac-v${version}.zip`)),
]);
fs.rmSync(bundledServer, { force: true });
fs.rmSync(path.join(releaseDir, "windows"), { recursive: true, force: true });
fs.rmSync(path.join(releaseDir, "mac"), { recursive: true, force: true });

console.log(`完了: ${releaseDir}`);

function zipDir(srcDir, outFile) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(srcDir, false);
    void archive.finalize();
  });
}
