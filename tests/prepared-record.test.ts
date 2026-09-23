import assert from "node:assert/strict";
import test from "node:test";
import { PREPARED_FIXTURE_KEY } from "../src/fixture.ts";
import {
  PREPARED_RECORD_VERSION,
  PreparedRecordError,
  parsePreparedRecord,
  serializePreparedRecord,
} from "../src/prepared-record.ts";
import { buildViaGraph, buildViaLap } from "../src/via-lap.ts";
import { gridGraph, syntheticFixture } from "./synthetic-grid.ts";

const grid = gridGraph(4, 4, 60);
const graph = buildViaGraph(grid.roads, grid.bbox);
const vias = [
  grid.nodeId(0, 1),
  grid.nodeId(1, 3),
  grid.nodeId(3, 2),
  grid.nodeId(2, 0),
];
const lap = buildViaLap(graph, vias);
const fixture = syntheticFixture(grid.roads, grid.bbox, {
  roadWidthMeters: 14,
  checkpointFractions: lap.checkpointFractions,
  lapLengthMeters: lap.lapLengthMeters,
  lapNodeIds: lap.lapNodeIds,
  viaNodeIds: lap.viaNodeIds,
});

test("保存キーは従来のままである", () => {
  assert.equal(PREPARED_FIXTURE_KEY, "kinjo-race:prepared-fixture:v1");
});

test("範囲と経由順を含めて往復保存できる", () => {
  const text = serializePreparedRecord({
    bbox: grid.bbox,
    viaNodeIds: vias,
    fixture,
  });
  const record = parsePreparedRecord(text);
  assert.equal(record.recordVersion, PREPARED_RECORD_VERSION);
  assert.deepEqual(record.bbox, grid.bbox);
  assert.deepEqual([...record.viaNodeIds], vias);
  assert.deepEqual(record.fixture.course.lapNodeIds, lap.lapNodeIds);
  assert.deepEqual(record.fixture.roads, grid.roads);
});

test("経由順のない旧記録は今までどおり読める", () => {
  const legacy = syntheticFixture(grid.roads, grid.bbox, {
    roadWidthMeters: 14,
    checkpointFractions: [0.2, 0.4, 0.6, 0.8],
    lapLengthMeters: lap.lapLengthMeters,
    lapNodeIds: lap.lapNodeIds,
  });
  const record = parsePreparedRecord(JSON.stringify(legacy));
  assert.equal(record.recordVersion, PREPARED_RECORD_VERSION);
  assert.deepEqual(record.viaNodeIds, []);
  assert.deepEqual(record.bbox, grid.bbox);
  assert.deepEqual(record.fixture.course.lapNodeIds, lap.lapNodeIds);
});

test("壊れたJSONは parse として明示的に失敗する", () => {
  assert.throws(
    () => parsePreparedRecord("{壊れています"),
    (error: unknown) =>
      error instanceof PreparedRecordError &&
      error.code === "parse" &&
      error.message.includes("保存データを読めませんでした") &&
      error.message.includes("parse"),
  );
});

test("知らない版の記録は version として明示的に失敗する", () => {
  const future = JSON.stringify({
    recordVersion: PREPARED_RECORD_VERSION + 9,
    bbox: grid.bbox,
    viaNodeIds: vias,
    fixture,
  });
  assert.throws(
    () => parsePreparedRecord(future),
    (error: unknown) =>
      error instanceof PreparedRecordError &&
      error.code === "version" &&
      error.message.includes("version"),
  );
  assert.throws(
    () =>
      parsePreparedRecord(
        JSON.stringify({ ...fixture, schemaVersion: 9 }),
      ),
    (error: unknown) =>
      error instanceof PreparedRecordError && error.code === "version",
  );
});

test("形の違う記録は shape として明示的に失敗する", () => {
  const broken = [
    JSON.stringify(null),
    JSON.stringify([1, 2, 3]),
    JSON.stringify({ recordVersion: PREPARED_RECORD_VERSION }),
    JSON.stringify({
      recordVersion: PREPARED_RECORD_VERSION,
      bbox: grid.bbox,
      viaNodeIds: ["いち"],
      fixture,
    }),
    JSON.stringify({
      recordVersion: PREPARED_RECORD_VERSION,
      bbox: { south: 1 },
      viaNodeIds: [],
      fixture,
    }),
    JSON.stringify({
      recordVersion: PREPARED_RECORD_VERSION,
      bbox: grid.bbox,
      viaNodeIds: [],
      fixture: { ...fixture, roads: "道路" },
    }),
  ];
  for (const text of broken) {
    assert.throws(
      () => parsePreparedRecord(text),
      (error: unknown) =>
        error instanceof PreparedRecordError &&
        error.code === "shape" &&
        error.message.includes("保存データを読めませんでした"),
      `${text.slice(0, 60)} は shape で失敗するべきです。`,
    );
  }
});
