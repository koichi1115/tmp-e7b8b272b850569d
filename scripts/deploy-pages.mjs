/**
 * GitHub Pages へ公開します。
 *
 * 本来は .github/workflows/pages.yml（= ci/pages.yml）の Actions で配信します。
 * いまの資格情報には `workflow` スコープが無く、ワークフローを push できないため、
 * 同じ成果物を gh-pages ブランチへ載せる「ブランチ配信」を使います。
 * ワークフローを push できるようになったら ci/pages.yml を
 * .github/workflows/pages.yml へ戻し、このスクリプトは不要になります。
 *
 * 必ず KINJO_BASE を付けてビルドし、静的スモークが通ったものだけを公開します。
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DIST = resolve(ROOT, "dist");
const BRANCH = process.env.PAGES_BRANCH ?? "gh-pages";
const BASE = process.env.KINJO_BASE;

if (!BASE) {
  console.error("KINJO_BASE を指定してください（例: /tmp-e7b8b272b850569d/）。");
  process.exit(1);
}

// stdout を継承したときは execFileSync が null を返すため、空文字へ寄せます。
const run = (command, args, options = {}) =>
  (
    execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      ...options,
    }) ?? ""
  ).trim();

const remoteUrl = run("git", ["remote", "get-url", "origin"]);
const sourceCommit = run("git", ["rev-parse", "HEAD"]);
const sourceStatus = run("git", ["status", "--porcelain"]);
if (sourceStatus !== "") {
  console.error("作業ツリーが汚れています。公開は tip のみから行います。");
  process.exit(1);
}

console.log(`KINJO_BASE=${BASE} でビルドします。`);
rmSync(DIST, { recursive: true, force: true });
run("npm", ["run", "pages:build"], {
  env: { ...process.env, KINJO_BASE: BASE },
  stdio: ["ignore", "inherit", "inherit"],
});

console.log("静的スモークを実行します。");
run("node", ["scripts/verify-public-play.mjs", "--static", "--base", BASE], {
  stdio: ["ignore", "inherit", "inherit"],
});

// Jekyll に触らせず、そのまま静的配信させます。
writeFileSync(resolve(DIST, ".nojekyll"), "");

if (!existsSync(resolve(DIST, "index.html"))) {
  console.error("dist/index.html がありません。公開を中止します。");
  process.exit(1);
}

console.log(`${BRANCH} ブランチへ公開します。`);
rmSync(resolve(DIST, ".git"), { recursive: true, force: true });
const inDist = { cwd: DIST };
run("git", ["init", "-q", "-b", BRANCH], inDist);
run("git", ["add", "-A"], inDist);
run(
  "git",
  [
    "-c",
    "user.name=saiko1115",
    "-c",
    "user.email=k.shimada1115@gmail.com",
    "commit",
    "-q",
    "-m",
    `公開ビルド ${sourceCommit} (KINJO_BASE=${BASE})`,
  ],
  inDist,
);
run("git", ["remote", "add", "origin", remoteUrl], inDist);
run("git", ["push", "--force", "-q", "origin", `${BRANCH}:${BRANCH}`], {
  ...inDist,
  stdio: ["ignore", "inherit", "inherit"],
});
const publishedCommit = run("git", ["rev-parse", "HEAD"], inDist);
rmSync(resolve(DIST, ".git"), { recursive: true, force: true });

console.log(
  `公開しました。元コミット ${sourceCommit} / ${BRANCH} コミット ${publishedCommit}`,
);
