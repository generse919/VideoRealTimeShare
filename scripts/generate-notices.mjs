// 配布物に同梱する THIRD-PARTY-NOTICES.txt を生成する。
//
// バンドルした依存ライブラリはほとんどが MIT で、MIT は著作権表示と許諾表示を
// 「ソフトウェアの複製物に含めること」を条件にしている。esbuild の legalComments は
// ソース中にコメントとして書かれた表示しか拾えず (ws や localtunnel のように
// ファイル先頭に表示を持たないパッケージは漏れる)、条件を満たせないため、
// 実際にインストールされた各パッケージの LICENSE ファイルから組み立てる。
import fs from "node:fs";
import path from "node:path";

const LICENSE_FILENAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
  "COPYING",
];

/**
 * 本番依存 (devDependencies を除く) のインストール先ディレクトリを列挙する。
 *
 * `npm ls` を呼ばずに node_modules を自力で辿るのは、Windows の Node 24 以降で
 * npm.cmd を直接起動できない (EINVAL) ためと、シェル経由を避けるため。
 */
function productionPackageDirs(root) {
  /** Node の解決規則どおり、起点から上へ node_modules/<name> を探す */
  const resolveDir = (name, fromDir) => {
    let dir = fromDir;
    for (;;) {
      const candidate = path.join(dir, "node_modules", name);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir || parent.length < root.length) return null;
      dir = parent;
    }
  };

  const readPkg = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      return null;
    }
  };

  const rootPkg = readPkg(root);
  if (!rootPkg) throw new Error(`package.json を読めません: ${root}`);

  const found = new Set();
  // [依存名, その依存を要求したパッケージのディレクトリ]
  const queue = Object.keys(rootPkg.dependencies ?? {}).map((name) => [name, root]);

  while (queue.length > 0) {
    const [name, fromDir] = queue.shift();
    const dir = resolveDir(name, fromDir);
    if (!dir || found.has(dir)) continue;
    found.add(dir);
    const pkg = readPkg(dir);
    // 推移的な依存もライセンス表示の対象 (optional は実際に入っているものだけ辿られる)
    for (const dep of Object.keys(pkg?.dependencies ?? {})) queue.push([dep, dir]);
  }
  return [...found].sort();
}

function findLicenseFile(dir) {
  for (const name of LICENSE_FILENAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

export function generateNotices(root) {
  const sections = [];
  const missing = [];

  for (const dir of productionPackageDirs(root)) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const title = `${pkg.name}@${pkg.version}`;
    const licenseId = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "(未宣言)");
    const licenseFile = findLicenseFile(dir);

    const header = [
      "=".repeat(78),
      title,
      `License: ${licenseId}`,
      pkg.homepage ? `Homepage: ${pkg.homepage}` : null,
      "=".repeat(78),
    ]
      .filter(Boolean)
      .join("\n");

    if (licenseFile) {
      sections.push(`${header}\n\n${fs.readFileSync(licenseFile, "utf8").trim()}\n`);
    } else {
      missing.push(`${title} (${licenseId})`);
      sections.push(`${header}\n\n(このパッケージには個別のライセンスファイルが同梱されていません。上記の License を参照してください。)\n`);
    }
  }

  const intro = [
    "VideoRealTime 第三者ソフトウェアのライセンス表示",
    "",
    "本ソフトウェアには以下のオープンソースライブラリが含まれています。",
    "それぞれの著作権表示および許諾条件を以下に掲載します。",
    "",
    `対象パッケージ数: ${sections.length}`,
    "",
  ].join("\n");

  if (missing.length > 0) {
    console.warn(`[notices] ライセンスファイルが見つからないパッケージ: ${missing.join(", ")}`);
  }
  return `${intro}\n${sections.join("\n")}`;
}
