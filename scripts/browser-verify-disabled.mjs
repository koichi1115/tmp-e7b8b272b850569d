/**
 * 旧 browser:verify は VM 復元ギャップで scripts/verify-browser.mjs が
 * startSnapshot 未定義のまま壊れています。緑のふりをしないため無効化。
 * ブラウザ系の証明は npm run build-mode:verify を使うこと。
 */
console.error(
  "browser:verify は無効です（復元ギャップ: startSnapshot is not defined）。build-mode:verify を使ってください。",
);
process.exit(1);
