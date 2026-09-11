import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  VEHICLE_IDS,
  clampVehicleSpeed,
  isRoadPassable,
  vehicleMaxSpeed,
} from "../src/vehicles.ts";

const fixture = JSON.parse(
  await readFile(
    new URL("../src/data/neighborhood.json", import.meta.url),
    "utf8",
  ),
);

test("固定データの道路種別が想定どおりである", () => {
  const highwayClasses = [
    ...new Set<string>(
      fixture.roads.map((road: { highway: string }) => road.highway),
    ),
  ].sort();
  assert.deepEqual(highwayClasses, [
    "residential",
    "secondary",
    "service",
    "tertiary",
    "unclassified",
  ]);
});

test("車両ごとの通行可否が固定ルールに従う", () => {
  assert.equal(isRoadPassable("street", "residential"), true);
  assert.equal(isRoadPassable("street", "tertiary"), true);
  assert.equal(isRoadPassable("street", "secondary"), true);
  assert.equal(isRoadPassable("street", "unclassified"), true);
  assert.equal(isRoadPassable("street", "service"), false);

  assert.equal(isRoadPassable("alley", "residential"), true);
  assert.equal(isRoadPassable("alley", "tertiary"), true);
  assert.equal(isRoadPassable("alley", "secondary"), false);
  assert.equal(isRoadPassable("alley", "unclassified"), true);
  assert.equal(isRoadPassable("alley", "service"), true);
});

test("両車両が固定周回の全道路辺を通行できる", () => {
  const classesByEdge = new Map<string, string>();
  for (const road of fixture.roads) {
    for (let index = 1; index < road.points.length; index += 1) {
      const first = road.points[index - 1][0];
      const second = road.points[index][0];
      const key =
        first < second ? `${first}:${second}` : `${second}:${first}`;
      classesByEdge.set(key, road.highway);
    }
  }

  for (const vehicleId of VEHICLE_IDS) {
    for (
      let index = 1;
      index < fixture.course.lapNodeIds.length;
      index += 1
    ) {
      const first = fixture.course.lapNodeIds[index - 1];
      const second = fixture.course.lapNodeIds[index];
      const key =
        first < second ? `${first}:${second}` : `${second}:${first}`;
      const highway = classesByEdge.get(key);
      assert.ok(highway, `道路辺 ${key} の種別がありません。`);
      assert.equal(
        isRoadPassable(vehicleId, highway),
        true,
        `${vehicleId} が周回辺 ${key} を通れません。`,
      );
    }
  }
});

test("最高速度と速度制限が車両ごとに異なる", () => {
  assert.equal(vehicleMaxSpeed("street"), 17);
  assert.equal(vehicleMaxSpeed("alley"), 11);
  assert.equal(clampVehicleSpeed(30, "street"), 17);
  assert.equal(clampVehicleSpeed(30, "alley"), 11);
  assert.equal(clampVehicleSpeed(-10, "street"), -6);
  assert.equal(clampVehicleSpeed(8, "alley"), 8);
});