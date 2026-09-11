import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  courseFromFixture,
  pointAtProgress,
} from "../src/course.ts";
import {
  MAX_BBOX_AREA_M2,
  OVERPASS_ENDPOINT,
  RangePreparationError,
  bboxSize,
  buildOverpassQuery,
  generateLap,
  prepareFixture,
} from "../src/free-range.ts";
import type { FixtureData } from "../src/fixture.ts";
import {
  VEHICLE_IDS,
  isRoadPassable,
} from "../src/vehicles.ts";

const sample = JSON.parse(
  await readFile(
    new URL("../src/data/free-range-sample.json", import.meta.url),
    "utf8",
  ),
) as FixtureData;

test("第二fixtureから同じ閉路を決定的に生成する", () => {
  const generated = generateLap(sample.roads, sample.bbox);
  assert.deepEqual(
    generated.lapNodeIds,
    sample.course.lapNodeIds,
  );
  assert.equal(
    generated.lapLengthMeters,
    sample.course.lapLengthMeters,
  );

  const course = courseFromFixture(sample);
  assert.equal(
    course.lap[0]?.x,
    course.lap.at(-1)?.x,
  );
  assert.equal(
    course.lap[0]?.y,
    course.lap.at(-1)?.y,
  );
  assert.equal(course.checkpointFractions.length, 4);
  for (const fraction of course.checkpointFractions) {
    const gate = pointAtProgress(course, fraction);
    assert.ok(Number.isFinite(gate.point.x));
    assert.ok(Number.isFinite(gate.point.y));
  }

  for (const vehicleId of VEHICLE_IDS) {
    for (const road of sample.roads) {
      const lapUsesRoad = road.points.some((point, index) => {
        const previous = road.points[index - 1];
        if (!previous) {
          return false;
        }
        return sample.course.lapNodeIds.some(
          (nodeId, lapIndex) => {
            const prior = sample.course.lapNodeIds[lapIndex - 1];
            return (
              (prior === previous[0] && nodeId === point[0]) ||
              (prior === point[0] && nodeId === previous[0])
            );
          },
        );
      });
      if (lapUsesRoad) {
        assert.equal(
          isRoadPassable(vehicleId, road.highway),
          true,
        );
      }
    }
  }
});

test("空の応答は道路なしとして失敗する", () => {
  assert.throws(
    () =>
      prepareFixture(
        { elements: [] },
        sample.bbox,
        {
          place: "空の試験範囲",
          capturedAt: "2026-09-05T22:20:00Z",
        },
      ),
    (error) =>
      error instanceof RangePreparationError &&
      error.code === "no_roads",
  );
});

test("一本の道路だけの応答は閉路なしとして失敗する", () => {
  const nodes = [1, 2, 3, 4, 5, 6, 7];
  const geometry = nodes.map((_, index) => ({
    lat: 35.7015 + index * 0.0001,
    lon: 139.6465 + index * 0.0001,
  }));
  assert.throws(
    () =>
      prepareFixture(
        {
          elements: [
            {
              type: "way",
              id: 100,
              nodes,
              geometry,
              tags: { highway: "residential" },
            },
          ],
        },
        sample.bbox,
        {
          place: "閉路なし試験範囲",
          capturedAt: "2026-09-05T22:20:00Z",
        },
      ),
    (error) =>
      error instanceof RangePreparationError &&
      error.code === "no_cycle",
  );
});

test("bbox面積上限を超える範囲は取得前に拒否する", () => {
  const tooLarge = {
    south: 35.69,
    west: 139.63,
    north: 35.71,
    east: 139.66,
  };
  assert.ok(bboxSize(tooLarge).area > MAX_BBOX_AREA_M2);
  assert.throws(
    () =>
      prepareFixture(
        { elements: [] },
        tooLarge,
        {
          place: "上限超過試験範囲",
          capturedAt: "2026-09-05T22:20:00Z",
        },
      ),
    (error) =>
      error instanceof RangePreparationError &&
      error.code === "bbox",
  );
});

test(
  "明示指定時だけOverpass応答を統合確認する",
  {
    skip: process.env.OVERPASS_INTEGRATION !== "1",
  },
  async () => {
    const query = buildOverpassQuery(sample.bbox);
    const response = await fetch(OVERPASS_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ data: query }),
    });
    assert.equal(response.ok, true);
    const prepared = prepareFixture(
      await response.json(),
      sample.bbox,
      {
        place: "統合試験範囲",
        capturedAt: new Date().toISOString(),
        query,
      },
    );
    assert.ok(prepared.course.lapNodeIds.length > 6);
  },
);