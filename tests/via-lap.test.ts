import assert from "node:assert/strict";
import test from "node:test";
import { courseFromFixture } from "../src/course.ts";
import type { FixtureRoad } from "../src/fixture.ts";
import {
  MAX_LAP_LENGTH_METERS,
  MIN_LAP_LENGTH_METERS,
  MIN_VIA_COUNT,
  ViaCourseError,
  buildViaGraph,
  buildViaLap,
  intersectionNodes,
  withViaCourse,
} from "../src/via-lap.ts";
import {
  disconnectedGraph,
  gridGraph,
  syntheticFixture,
} from "./synthetic-grid.ts";

const grid = gridGraph(4, 4, 60);
const graph = buildViaGraph(grid.roads, grid.bbox);
const corner = grid.nodeId(0, 0);
const vias = [
  grid.nodeId(0, 1),
  grid.nodeId(1, 3),
  grid.nodeId(3, 2),
  grid.nodeId(2, 0),
];

/** 道路点から course.ts と同じ投影で距離を測り直します。 */
const measure = (
  roads: readonly FixtureRoad[],
  bbox: (typeof grid)["bbox"],
  lapNodeIds: readonly number[],
): number => {
  const latitudeRadians = (((bbox.south + bbox.north) / 2) * Math.PI) / 180;
  const points = new Map<number, { x: number; y: number }>();
  for (const road of roads) {
    for (const point of road.points) {
      points.set(point[0], {
        x: (point[2] - bbox.west) * 111_320 * Math.cos(latitudeRadians),
        y: (bbox.north - point[1]) * 111_320,
      });
    }
  }
  let total = 0;
  for (let index = 1; index < lapNodeIds.length; index += 1) {
    const first = points.get(lapNodeIds[index - 1]!)!;
    const second = points.get(lapNodeIds[index]!)!;
    total += Math.hypot(second.x - first.x, second.y - first.y);
  }
  return total;
};

const edgeKey = (first: number, second: number) =>
  first < second ? `${first}:${second}` : `${second}:${first}`;

test("交差点は次数3以上の節点だけを番号順に返す", () => {
  const nodes = intersectionNodes(graph);
  assert.equal(nodes.length, 12);
  assert.deepEqual(
    [...nodes].map((node) => node.nodeId).sort((a, b) => a - b),
    nodes.map((node) => node.nodeId),
  );
  for (const node of nodes) {
    assert.ok(node.degree >= 3);
    assert.ok(Number.isFinite(node.latitude));
    assert.ok(Number.isFinite(node.longitude));
  }
  assert.equal(
    nodes.some((node) => node.nodeId === corner),
    false,
  );
});

test("指定した順に経由する閉じた周回路を作る", () => {
  const lap = buildViaLap(graph, vias);

  assert.equal(lap.lapNodeIds[0], lap.lapNodeIds.at(-1));
  assert.equal(lap.lapNodeIds[0], vias[0]);
  assert.ok(lap.lapNodeIds.length >= 4);

  // 経由点は指定した順番どおりに現れます。
  let searchFrom = 0;
  for (const via of vias) {
    const index = lap.lapNodeIds.indexOf(via, searchFrom);
    assert.ok(index >= searchFrom, `経由 ${via} が順番どおりにありません。`);
    searchFrom = index + 1;
  }

  // 全ての辺が道路グラフに実在し、二度は使いません。
  const used = new Set<string>();
  for (let index = 1; index < lap.lapNodeIds.length; index += 1) {
    const key = edgeKey(
      lap.lapNodeIds[index - 1]!,
      lap.lapNodeIds[index]!,
    );
    assert.equal(graph.edgeKeys.has(key), true, `辺 ${key} が道路にありません。`);
    assert.equal(used.has(key), false, `辺 ${key} を二度走っています。`);
    used.add(key);
  }

  const measured = measure(grid.roads, grid.bbox, lap.lapNodeIds);
  assert.ok(Math.abs(measured - lap.lapLengthMeters) <= 0.05);
  assert.ok(lap.lapLengthMeters >= MIN_LAP_LENGTH_METERS);
  assert.ok(lap.lapLengthMeters <= MAX_LAP_LENGTH_METERS);
  assert.deepEqual([...lap.viaNodeIds], vias);
});

test("チェックポイントは2番目以降の経由点に置かれる", () => {
  const lap = buildViaLap(graph, vias);
  assert.equal(lap.checkpointFractions.length, vias.length - 1);
  let previous = 0;
  for (const fraction of lap.checkpointFractions) {
    assert.ok(fraction > previous);
    assert.ok(fraction < 1);
    previous = fraction;
  }
});

test("同じ指定からは何度でも同じ周回路ができる", () => {
  assert.deepEqual(buildViaLap(graph, vias), buildViaLap(graph, vias));
});

test("経由点2つでも往復ではない閉路になる", () => {
  const lap = buildViaLap(graph, [grid.nodeId(0, 1), grid.nodeId(3, 2)]);
  assert.equal(lap.lapNodeIds[0], lap.lapNodeIds.at(-1));
  assert.equal(lap.checkpointFractions.length, 1);
  const used = new Set<string>();
  for (let index = 1; index < lap.lapNodeIds.length; index += 1) {
    const key = edgeKey(
      lap.lapNodeIds[index - 1]!,
      lap.lapNodeIds[index]!,
    );
    assert.equal(used.has(key), false);
    used.add(key);
  }
});

test("course.ts の閉路規則と長さ検査を満たす", () => {
  const lap = buildViaLap(graph, vias);
  const fixture = syntheticFixture(grid.roads, grid.bbox, {
    roadWidthMeters: 14,
    checkpointFractions: lap.checkpointFractions,
    lapLengthMeters: lap.lapLengthMeters,
    lapNodeIds: lap.lapNodeIds,
    viaNodeIds: lap.viaNodeIds,
  });
  const course = courseFromFixture(fixture);
  assert.equal(course.lap[0]?.x, course.lap.at(-1)?.x);
  assert.equal(course.lap[0]?.y, course.lap.at(-1)?.y);
  assert.equal(course.viaPoints.length, vias.length);
  assert.equal(
    course.checkpointFractions.length,
    lap.checkpointFractions.length,
  );
});

test("経由付きコースを既存fixtureへ差し替えても他の内容は変わらない", () => {
  const lap = buildViaLap(graph, vias);
  const original = syntheticFixture(grid.roads, grid.bbox, {
    roadWidthMeters: 14,
    checkpointFractions: [0.2, 0.4, 0.6, 0.8],
    lapLengthMeters: 0,
    lapNodeIds: [],
  });
  const replaced = withViaCourse(original, lap);
  assert.deepEqual(replaced.roads, original.roads);
  assert.deepEqual(replaced.bbox, original.bbox);
  assert.equal(replaced.course.roadWidthMeters, 14);
  assert.deepEqual([...replaced.course.viaNodeIds ?? []], vias);
  assert.deepEqual(replaced.course.lapNodeIds, lap.lapNodeIds);
});

test("経由点が2つ未満なら via_count で失敗する", () => {
  assert.equal(MIN_VIA_COUNT, 2);
  for (const candidate of [[], [vias[0]!]]) {
    assert.throws(
      () => buildViaLap(graph, candidate),
      (error: unknown) =>
        error instanceof ViaCourseError &&
        error.code === "via_count" &&
        error.message.includes("via_count"),
    );
  }
});

test("交差点でない節点は not_intersection で失敗する", () => {
  for (const candidate of [corner, 999_999]) {
    assert.throws(
      () => buildViaLap(graph, [candidate, vias[1]!]),
      (error: unknown) =>
        error instanceof ViaCourseError &&
        error.code === "not_intersection" &&
        error.message.includes("not_intersection"),
    );
  }
});

test("同じ経由点が続くと duplicate_via で失敗する", () => {
  assert.throws(
    () => buildViaLap(graph, [vias[0]!, vias[0]!, vias[1]!]),
    (error: unknown) =>
      error instanceof ViaCourseError && error.code === "duplicate_via",
  );
  assert.throws(
    () => buildViaLap(graph, [vias[0]!, vias[1]!, vias[0]!]),
    (error: unknown) =>
      error instanceof ViaCourseError && error.code === "duplicate_via",
  );
});

test("繋がっていない経由点は unreachable で失敗する", () => {
  const separated = disconnectedGraph();
  const separatedGraph = buildViaGraph(separated.roads, separated.bbox);
  assert.throws(
    () =>
      buildViaLap(separatedGraph, [
        separated.firstCenter,
        separated.secondCenter,
      ]),
    (error: unknown) =>
      error instanceof ViaCourseError &&
      error.code === "unreachable" &&
      error.message.includes("unreachable"),
  );
});

test("短すぎる・長すぎる周回路は lap_length で失敗する", () => {
  const tiny = gridGraph(3, 3, 10);
  const tinyGraph = buildViaGraph(tiny.roads, tiny.bbox);
  assert.throws(
    () => buildViaLap(tinyGraph, [tiny.nodeId(0, 1), tiny.nodeId(1, 2)]),
    (error: unknown) =>
      error instanceof ViaCourseError &&
      error.code === "lap_length" &&
      error.message.includes("lap_length"),
  );
  const huge = gridGraph(4, 4, 400);
  const hugeGraph = buildViaGraph(huge.roads, huge.bbox);
  assert.throws(
    () =>
      buildViaLap(hugeGraph, [
        huge.nodeId(0, 1),
        huge.nodeId(1, 3),
        huge.nodeId(3, 2),
        huge.nodeId(2, 0),
      ]),
    (error: unknown) =>
      error instanceof ViaCourseError && error.code === "lap_length",
  );
});
