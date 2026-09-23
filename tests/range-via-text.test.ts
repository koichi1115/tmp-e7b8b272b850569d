/**
 * 経由UIの文言。DOM を作らずに、分割しても同じ言葉が出ることだけを固定します。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { viaMarkerLabel, viaStatusText } from "../src/range-via-ui.ts";

test("準備前は案内文を出さない", () => {
  assert.equal(viaStatusText(false, 0), "");
  assert.equal(viaStatusText(false, 3), "");
});

test("準備後・経由0点ならタップを促す", () => {
  assert.equal(
    viaStatusText(true, 0),
    "地図の交差点を、通りたい順にタップしてください。",
  );
});

test("経由が溜まったら点数と確定の条件を出す", () => {
  assert.equal(
    viaStatusText(true, 1),
    "経由 1 点。2点以上で「経由でコース確定」を押せます。",
  );
  assert.equal(
    viaStatusText(true, 3),
    "経由 3 点。2点以上で「経由でコース確定」を押せます。",
  );
});

test("印の読み上げ名は選ぶ前後で変わる", () => {
  assert.equal(viaMarkerLabel(102, 0), "交差点 102");
  assert.equal(viaMarkerLabel(102, 2), "交差点 102・経由 2 番目");
});
