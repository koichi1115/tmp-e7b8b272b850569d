import assert from "node:assert/strict";
import test from "node:test";
import {
  TILE_SIZE,
  bboxCenter,
  bboxSpan,
  panBbox,
  pointToViewportPixels,
  projectToPixels,
  tileMosaic,
  unprojectFromPixels,
} from "../src/map-pan.ts";
import { MAX_BBOX_AREA_M2, bboxSize, validateBbox } from "../src/free-range.ts";
import type { Bbox } from "../src/fixture.ts";

const bbox: Bbox = {
  south: 35.701,
  west: 139.646,
  north: 35.704,
  east: 139.65,
};

const viewport = { zoom: 16, widthPx: 600, heightPx: 260 } as const;

test("ピクセル変換は往復しても同じ緯度経度に戻る", () => {
  for (const [latitude, longitude] of [
    [35.7025, 139.648],
    [-33.86, 151.21],
    [0, 0],
    [60.17, 24.94],
  ] as const) {
    const pixels = projectToPixels(latitude, longitude, 16);
    const back = unprojectFromPixels(pixels, 16);
    assert.ok(Math.abs(back.latitude - latitude) < 1e-9);
    assert.ok(Math.abs(back.longitude - longitude) < 1e-9);
  }
});

test("ズーム16のタイル座標はウェブメルカトルの定義どおり", () => {
  const pixels = projectToPixels(0, 0, 16);
  const world = TILE_SIZE * 2 ** 16;
  assert.ok(Math.abs(pixels.x - world / 2) < 1e-6);
  assert.ok(Math.abs(pixels.y - world / 2) < 1e-6);
  const east = projectToPixels(0, 180, 16);
  assert.ok(Math.abs(east.x - world) < 1e-6);
});

test("タイルは等倍で並び、範囲の中心が表示の中心に来る", () => {
  const mosaic = tileMosaic(bbox, viewport);
  const center = bboxCenter(bbox);
  const centerPixels = pointToViewportPixels(
    center.latitude,
    center.longitude,
    mosaic.originPx,
    viewport.zoom,
  );
  assert.ok(Math.abs(centerPixels.x - viewport.widthPx / 2) < 1e-6);
  assert.ok(Math.abs(centerPixels.y - viewport.heightPx / 2) < 1e-6);
});

test("タイルは表示領域を隙間なく覆う", () => {
  const mosaic = tileMosaic(bbox, viewport);
  assert.ok(mosaic.tiles.length >= 6);
  const lefts = mosaic.tiles.map((tile) => tile.leftPx);
  const tops = mosaic.tiles.map((tile) => tile.topPx);
  assert.ok(Math.min(...lefts) <= 0);
  assert.ok(Math.max(...lefts) + TILE_SIZE >= viewport.widthPx);
  assert.ok(Math.min(...tops) <= 0);
  assert.ok(Math.max(...tops) + TILE_SIZE >= viewport.heightPx);
  for (const tile of mosaic.tiles) {
    assert.equal(tile.zoom, viewport.zoom);
    assert.ok(Number.isInteger(tile.x) && Number.isInteger(tile.y));
    assert.ok(tile.leftPx > -TILE_SIZE && tile.leftPx < viewport.widthPx);
    assert.ok(tile.topPx > -TILE_SIZE && tile.topPx < viewport.heightPx);
  }
});

test("範囲の四隅は表示画素へ線形に写る", () => {
  const mosaic = tileMosaic(bbox, viewport);
  const northWest = pointToViewportPixels(
    bbox.north,
    bbox.west,
    mosaic.originPx,
    viewport.zoom,
  );
  const southEast = pointToViewportPixels(
    bbox.south,
    bbox.east,
    mosaic.originPx,
    viewport.zoom,
  );
  assert.ok(northWest.x < southEast.x);
  assert.ok(northWest.y < southEast.y);
  const widthPx =
    projectToPixels(bbox.south, bbox.east, viewport.zoom).x -
    projectToPixels(bbox.south, bbox.west, viewport.zoom).x;
  assert.ok(Math.abs(southEast.x - northWest.x - widthPx) < 1e-6);
});

test("パンすると地図は指の向きへ、範囲は逆向きへ動く", () => {
  const dragged = panBbox(bbox, { x: -80, y: 0 }, viewport.zoom);
  const before = tileMosaic(bbox, viewport);
  const after = tileMosaic(dragged, viewport);
  const spot = (mosaic: typeof before) =>
    pointToViewportPixels(
      bbox.north,
      bbox.west,
      mosaic.originPx,
      viewport.zoom,
    ).x;
  // 右へ80px引くと、同じ地点は表示上も80px右へ動きます。
  assert.ok(Math.abs(spot(after) - spot(before) - 80) < 1e-6);
  assert.ok(dragged.west < bbox.west);
});

test("パンは範囲の大きさを変えずに平行移動する", () => {
  const moved = panBbox(bbox, { x: 120, y: -40 }, 16);
  const before = bboxSpan(bbox);
  const after = bboxSpan(moved);
  assert.ok(Math.abs(after.latitudeSpan - before.latitudeSpan) < 1e-12);
  assert.ok(Math.abs(after.longitudeSpan - before.longitudeSpan) < 1e-12);
  // 指の向きへ枠が動く: 右へ引けば東、上へ引けば北。
  assert.ok(moved.west > bbox.west);
  assert.ok(moved.south > bbox.south);
  validateBbox(moved);
  assert.ok(bboxSize(moved).area <= MAX_BBOX_AREA_M2);
});

test("ドラッグ量ゼロは元の範囲と完全に一致する", () => {
  assert.deepEqual(panBbox(bbox, { x: 0, y: 0 }, 16), bbox);
});

test("逆向きに同じだけパンすると元の範囲へ戻る", () => {
  const moved = panBbox(bbox, { x: 87.5, y: 42.25 }, 16);
  const back = panBbox(moved, { x: -87.5, y: -42.25 }, 16);
  assert.ok(Math.abs(back.south - bbox.south) < 1e-10);
  assert.ok(Math.abs(back.west - bbox.west) < 1e-10);
  assert.ok(Math.abs(back.north - bbox.north) < 1e-10);
  assert.ok(Math.abs(back.east - bbox.east) < 1e-10);
});

test("パン量は現在ズームの尺度に従う", () => {
  const moved = panBbox(bbox, { x: 256, y: 0 }, 16);
  const expected = (256 * 360) / (TILE_SIZE * 2 ** 16);
  assert.ok(Math.abs(moved.west - (bbox.west + expected)) < 1e-9);
  assert.ok(Math.abs(moved.east - (bbox.east + expected)) < 1e-9);
  const zoomedOut = panBbox(bbox, { x: 256, y: 0 }, 15);
  assert.ok(
    Math.abs(zoomedOut.west - (bbox.west + expected * 2)) < 1e-9,
  );
});

test("極と日付変更線を越えるパンは範囲を保ったまま止まる", () => {
  const north = panBbox(bbox, { x: 0, y: -1_000_000_000 }, 16);
  assert.ok(north.north <= 85);
  assert.ok(
    Math.abs(
      bboxSpan(north).latitudeSpan - bboxSpan(bbox).latitudeSpan,
    ) < 1e-12,
  );
  // 極付近は東西幅が縮むため validateBbox は通りません（既存の規則どおり）。
  const east = panBbox(bbox, { x: 40_000_000, y: 0 }, 16);
  assert.ok(east.east <= 180);
  assert.ok(
    Math.abs(
      bboxSpan(east).longitudeSpan - bboxSpan(bbox).longitudeSpan,
    ) < 1e-12,
  );
  validateBbox(east);
});

test("中心は南北・東西の中点である", () => {
  const center = bboxCenter(bbox);
  assert.equal(center.latitude, (bbox.south + bbox.north) / 2);
  assert.equal(center.longitude, (bbox.west + bbox.east) / 2);
});

test("有限でない座標のパンは明示的に失敗する", () => {
  assert.throws(() => panBbox(bbox, { x: Number.NaN, y: 0 }, 16));
  assert.throws(() => dragToTilePixels({ x: 1, y: 1 }, { ...grid, widthPx: 0 }));
});
