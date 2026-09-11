import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const path = new URL("../src/data/neighborhood.json", import.meta.url);
const bytes = await readFile(path);
const fixture = JSON.parse(bytes);
const fail = (message) => {
  throw new Error(message);
};
const EXPECTED_COURSE_NODE_IDS = [
  365292733,
  6057627917,
  365293211,
  365293213,
  502925293,
  1673358946,
  1673358910,
  1673358903,
  355573140,
  502925553,
  6057627915,
  502925541,
  365292733,
];

if (fixture.schemaVersion !== 2) {
  fail("Unexpected fixture schema version.");
}
if (
  fixture.source.attribution !== "© OpenStreetMap contributors" ||
  fixture.source.license !== "ODbL 1.0"
) {
  fail("Required data attribution is missing.");
}
if (!Array.isArray(fixture.roads) || fixture.roads.length === 0) {
  fail("The fixture contains no road lines.");
}
if (!Array.isArray(fixture.buildings) || fixture.buildings.length === 0) {
  fail("The fixture contains no building footprints.");
}
if (!Array.isArray(fixture.landAreas) || fixture.landAreas.length === 0) {
  fail("The fixture contains no normalized land areas.");
}

const { south, west, north, east } = fixture.bbox;
const coordinateIsInside = (latitude, longitude) =>
  latitude >= south &&
  latitude <= north &&
  longitude >= west &&
  longitude <= east;
const pointsByNode = new Map();
const segmentKeys = new Set();
const neighborsByNode = new Map();
for (const road of fixture.roads) {
  if (!Array.isArray(road.points) || road.points.length < 2) {
    fail(`Road ${road.id} is not a centerline.`);
  }
  for (let index = 0; index < road.points.length; index += 1) {
    const point = road.points[index];
    const [nodeId, latitude, longitude] = point;
    if (!coordinateIsInside(latitude, longitude)) {
      fail(`Road ${road.id} leaves the fixed bbox.`);
    }
    pointsByNode.set(nodeId, point);
    if (index > 0) {
      const previous = road.points[index - 1][0];
      segmentKeys.add(
        previous < nodeId
          ? `${previous}:${nodeId}`
          : `${nodeId}:${previous}`,
      );
      for (const [from, to] of [
        [previous, nodeId],
        [nodeId, previous],
      ]) {
        const neighbors = neighborsByNode.get(from) ?? new Set();
        neighbors.add(to);
        neighborsByNode.set(from, neighbors);
      }
    }
  }
}

const heightSources = { height: 0, levels: 0, default: 0 };
for (const building of fixture.buildings) {
  if (
    !Array.isArray(building.points) ||
    building.points.length < 4 ||
    building.points[0][0] !== building.points.at(-1)[0] ||
    building.points[0][1] !== building.points.at(-1)[1]
  ) {
    fail(`Building ${building.id} is not a closed footprint.`);
  }
  if (
    typeof building.heightMeters !== "number" ||
    building.heightMeters <= 0 ||
    !Object.hasOwn(heightSources, building.heightSource)
  ) {
    fail(`Building ${building.id} has invalid height metadata.`);
  }
  heightSources[building.heightSource] += 1;
  for (const [latitude, longitude] of building.points) {
    if (!coordinateIsInside(latitude, longitude)) {
      fail(`Building ${building.id} leaves the fixed bbox.`);
    }
  }
}

const landCategories = { park: 0, grass: 0, wood: 0, water: 0 };
for (const area of fixture.landAreas) {
  if (
    !Array.isArray(area.points) ||
    area.points.length < 4 ||
    area.points[0][0] !== area.points.at(-1)[0] ||
    area.points[0][1] !== area.points.at(-1)[1] ||
    !Object.hasOwn(landCategories, area.category)
  ) {
    fail(`Land area ${area.id} is invalid.`);
  }
  landCategories[area.category] += 1;
  for (const [latitude, longitude] of area.points) {
    if (!coordinateIsInside(latitude, longitude)) {
      fail(`Land area ${area.id} leaves the fixed bbox.`);
    }
  }
}

const expectedStats = fixture.featureStats;
if (
  expectedStats.buildings.total !== fixture.buildings.length ||
  expectedStats.landAreas.total !== fixture.landAreas.length ||
  JSON.stringify(expectedStats.buildings.heightSources) !==
    JSON.stringify(heightSources) ||
  JSON.stringify(expectedStats.landAreas.categories) !==
    JSON.stringify(landCategories)
) {
  fail("Stored feature statistics do not match the fixture.");
}

const lap = fixture.course.lapNodeIds;
if (lap.length < 8 || lap[0] !== lap[lap.length - 1]) {
  fail("The lap is not a closed graph cycle.");
}
if (JSON.stringify(lap) !== JSON.stringify(EXPECTED_COURSE_NODE_IDS)) {
  fail("The lap node sequence differs from the committed course snapshot.");
}
if (new Set(lap.slice(0, -1)).size !== lap.length - 1) {
  fail("The lap repeats a node before returning to its start.");
}

const courseIntersectionCount = lap
  .slice(0, -1)
  .filter((nodeId) => (neighborsByNode.get(nodeId)?.size ?? 0) >= 3)
  .length;
if (courseIntersectionCount < 5) {
  fail("The lap does not pass through five road intersections.");
}

const latitudeRadians = (((south + north) / 2) * Math.PI) / 180;
const project = ([, latitude, longitude]) => ({
  x: (longitude - west) * 111_320 * Math.cos(latitudeRadians),
  y: (north - latitude) * 111_320,
});
let lapLength = 0;
for (let index = 1; index < lap.length; index += 1) {
  const previousId = lap[index - 1];
  const nodeId = lap[index];
  const key =
    previousId < nodeId
      ? `${previousId}:${nodeId}`
      : `${nodeId}:${previousId}`;
  if (!segmentKeys.has(key)) {
    fail(`Lap segment ${key} is absent from the fixture graph.`);
  }
  const previous = pointsByNode.get(previousId);
  const point = pointsByNode.get(nodeId);
  if (!previous || !point) {
    fail(`Lap node ${nodeId} is absent from the fixture.`);
  }
  const a = project(previous);
  const b = project(point);
  lapLength += Math.hypot(a.x - b.x, a.y - b.y);
}

if (Math.abs(lapLength - fixture.course.lapLengthMeters) > 0.02) {
  fail("The stored lap length does not match its centerline.");
}

const digest = createHash("sha256").update(bytes).digest("hex");
console.log(
  `固定データ検証済み: 道路中心線 ${fixture.roads.length} 本、周回区間 ${lap.length - 1} 本、${lapLength.toFixed(2)} m、SHA-256 ${digest}`,
);