import { mkdir, writeFile } from "node:fs/promises";

const BBOX = {
  south: 35.651,
  west: 139.6415,
  north: 35.655,
  east: 139.647,
};
const SNAPSHOT = "2025-01-01T00:00:00Z";
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const QUERY = `[out:json][timeout:90][date:"${SNAPSHOT}"];(way[highway](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});way[building](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});way[landuse](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});way[leisure](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});way[natural](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});way[water](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}););out geom;`;
const DISPLAY_TYPES = new Set([
  "living_street",
  "residential",
  "service",
  "secondary",
  "tertiary",
  "unclassified",
]);
const LAP_TYPES = new Set([
  "living_street",
  "residential",
  "tertiary",
  "unclassified",
]);
const COURSE_NODE_IDS = [
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

const requestPayload = async () => {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    for (const delay of [0, 1_500]) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "kinjo-race-fixture/0.2",
          },
          body: new URLSearchParams({ data: QUERY }),
        });
        if (!response.ok) {
          throw new Error(
            `Fixture data request failed with HTTP ${response.status}.`,
          );
        }
        return { endpoint, payload: await response.json() };
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError;
};

const response = await requestPayload();
const { payload } = response;
if (!Array.isArray(payload.elements)) {
  throw new Error("Fixture data response has no elements array.");
}

const allWays = payload.elements
  .filter(
    (element) =>
      element.type === "way" &&
      Array.isArray(element.nodes) &&
      Array.isArray(element.geometry) &&
      typeof element.tags === "object",
  )
  .sort((left, right) => left.id - right.id);
const ways = allWays.filter(
  (element) => typeof element.tags.highway === "string",
);

const isInside = ({ lat, lon }) =>
  lat >= BBOX.south &&
  lat <= BBOX.north &&
  lon >= BBOX.west &&
  lon <= BBOX.east;

const sameCoordinate = (first, second) =>
  first.lat === second.lat && first.lon === second.lon;

const interpolateAt = (first, second, axis, boundary) => {
  const amount =
    (boundary - first[axis]) / (second[axis] - first[axis]);
  return {
    lat: first.lat + (second.lat - first.lat) * amount,
    lon: first.lon + (second.lon - first.lon) * amount,
  };
};

const clipEdge = (points, inside, intersection) => {
  const clipped = [];
  let previous = points.at(-1);
  if (!previous) {
    return clipped;
  }
  for (const point of points) {
    const pointInside = inside(point);
    const previousInside = inside(previous);
    if (pointInside !== previousInside) {
      clipped.push(intersection(previous, point));
    }
    if (pointInside) {
      clipped.push(point);
    }
    previous = point;
  }
  return clipped;
};

const clipPolygon = (geometry) => {
  let points = geometry.slice(0, -1);
  points = clipEdge(
    points,
    (point) => point.lon >= BBOX.west,
    (first, second) => interpolateAt(first, second, "lon", BBOX.west),
  );
  points = clipEdge(
    points,
    (point) => point.lon <= BBOX.east,
    (first, second) => interpolateAt(first, second, "lon", BBOX.east),
  );
  points = clipEdge(
    points,
    (point) => point.lat >= BBOX.south,
    (first, second) => interpolateAt(first, second, "lat", BBOX.south),
  );
  points = clipEdge(
    points,
    (point) => point.lat <= BBOX.north,
    (first, second) => interpolateAt(first, second, "lat", BBOX.north),
  );
  if (points.length < 3) {
    return [];
  }
  return [...points, points[0]].map((point) => [point.lat, point.lon]);
};

const parsePositiveNumber = (value) => {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(?:m)?$/i);
  if (!match) {
    return null;
  }
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const buildingHeight = (tags) => {
  const taggedHeight = parsePositiveNumber(tags.height);
  if (taggedHeight !== null && taggedHeight <= 150) {
    return { heightMeters: taggedHeight, heightSource: "height" };
  }
  const levels = parsePositiveNumber(tags["building:levels"]);
  if (levels !== null && levels <= 50) {
    return {
      heightMeters: levels * 3,
      heightSource: "levels",
    };
  }
  return { heightMeters: 6, heightSource: "default" };
};

const landCategory = (tags) => {
  if (
    tags.natural === "water" ||
    typeof tags.water === "string" ||
    tags.landuse === "reservoir" ||
    tags.landuse === "basin"
  ) {
    return "water";
  }
  if (tags.natural === "wood" || tags.landuse === "forest") {
    return "wood";
  }
  if (
    tags.leisure === "park" ||
    tags.leisure === "garden" ||
    tags.leisure === "playground"
  ) {
    return "park";
  }
  if (
    tags.landuse === "grass" ||
    tags.landuse === "meadow" ||
    tags.landuse === "recreation_ground" ||
    tags.leisure === "pitch" ||
    tags.natural === "grassland"
  ) {
    return "grass";
  }
  return null;
};

const roads = [];
for (const way of ways) {
  if (!DISPLAY_TYPES.has(way.tags.highway)) {
    continue;
  }

  let part = [];
  let partIndex = 0;
  const flush = () => {
    if (part.length >= 2) {
      roads.push({
        id: `${way.id}:${partIndex}`,
        osmWayId: way.id,
        highway: way.tags.highway,
        name: way.tags.name ?? null,
        points: part,
      });
      partIndex += 1;
    }
    part = [];
  };

  for (let index = 0; index < way.nodes.length; index += 1) {
    const geometry = way.geometry[index];
    if (geometry && isInside(geometry)) {
      part.push([way.nodes[index], geometry.lat, geometry.lon]);
    } else {
      flush();
    }
  }
  flush();
}

const closedWays = allWays.filter((way) => {
  const first = way.geometry[0];
  const last = way.geometry.at(-1);
  return first && last && sameCoordinate(first, last);
});

const buildings = [];
const heightCounts = { height: 0, levels: 0, default: 0 };
for (const way of closedWays) {
  if (typeof way.tags.building !== "string") {
    continue;
  }
  const points = clipPolygon(way.geometry);
  if (points.length < 4) {
    continue;
  }
  const height = buildingHeight(way.tags);
  heightCounts[height.heightSource] += 1;
  buildings.push({
    id: `way/${way.id}`,
    osmWayId: way.id,
    ...height,
    points,
  });
}

const landAreas = [];
const landCounts = { park: 0, grass: 0, wood: 0, water: 0 };
for (const way of closedWays) {
  const category = landCategory(way.tags);
  if (category === null || typeof way.tags.building === "string") {
    continue;
  }
  const points = clipPolygon(way.geometry);
  if (points.length < 4) {
    continue;
  }
  landCounts[category] += 1;
  landAreas.push({
    id: `way/${way.id}`,
    osmWayId: way.id,
    category,
    points,
  });
}

const latitudeRadians =
  (((BBOX.south + BBOX.north) / 2) * Math.PI) / 180;
const project = ([, lat, lon]) => ({
  x: (lon - BBOX.west) * 111_320 * Math.cos(latitudeRadians),
  y: (BBOX.north - lat) * 111_320,
});
const nodePoints = new Map();
const edgeByKey = new Map();

for (const way of ways) {
  if (!LAP_TYPES.has(way.tags.highway)) {
    continue;
  }

  for (let index = 1; index < way.nodes.length; index += 1) {
    const firstGeometry = way.geometry[index - 1];
    const secondGeometry = way.geometry[index];
    if (
      !firstGeometry ||
      !secondGeometry ||
      !isInside(firstGeometry) ||
      !isInside(secondGeometry)
    ) {
      continue;
    }

    const first = [
      way.nodes[index - 1],
      firstGeometry.lat,
      firstGeometry.lon,
    ];
    const second = [
      way.nodes[index],
      secondGeometry.lat,
      secondGeometry.lon,
    ];
    const low = Math.min(first[0], second[0]);
    const high = Math.max(first[0], second[0]);
    const key = `${low}:${high}`;
    nodePoints.set(first[0], first);
    nodePoints.set(second[0], second);
    if (!edgeByKey.has(key)) {
      const a = project(first);
      const b = project(second);
      edgeByKey.set(key, {
        first: first[0],
        second: second[0],
        length: Math.hypot(a.x - b.x, a.y - b.y),
      });
    }
  }
}

const edges = [...edgeByKey.values()].sort(
  (left, right) =>
    left.first - right.first || left.second - right.second,
);
const adjacency = new Map();
for (const edge of edges) {
  for (const [from, to] of [
    [edge.first, edge.second],
    [edge.second, edge.first],
  ]) {
    const neighbors = adjacency.get(from) ?? [];
    neighbors.push({ to, edge });
    adjacency.set(from, neighbors);
  }
}
for (const neighbors of adjacency.values()) {
  neighbors.sort((left, right) => left.to - right.to);
}
if (
  COURSE_NODE_IDS.length < 9 ||
  COURSE_NODE_IDS[0] !== COURSE_NODE_IDS.at(-1)
) {
  throw new Error("The fixed course node sequence is not a closed cycle.");
}

let lapLength = 0;
for (let index = 1; index < COURSE_NODE_IDS.length; index += 1) {
  const first = COURSE_NODE_IDS[index - 1];
  const second = COURSE_NODE_IDS[index];
  const key = first < second ? `${first}:${second}` : `${second}:${first}`;
  const edge = edgeByKey.get(key);
  if (!edge || !nodePoints.has(first) || !nodePoints.has(second)) {
    throw new Error(`Fixed course edge ${key} is absent from the road graph.`);
  }
  lapLength += edge.length;
}

const courseIntersectionCount = COURSE_NODE_IDS.slice(0, -1).filter(
  (nodeId) => (adjacency.get(nodeId)?.length ?? 0) >= 3,
).length;
if (courseIntersectionCount < 5) {
  throw new Error("The fixed course no longer contains five intersections.");
}

const fixture = {
  schemaVersion: 2,
  place: "Miyasaka 2, Setagaya, Tokyo, Japan",
  bbox: BBOX,
  snapshot: SNAPSHOT,
  source: {
    name: "OpenStreetMap",
    endpoint: ENDPOINTS[0],
    fallbackEndpoints: ENDPOINTS,
    query: QUERY,
    attribution: "© OpenStreetMap contributors",
    license: "ODbL 1.0",
  },
  course: {
    roadWidthMeters: 14,
    checkpointFractions: [0.2, 0.4, 0.6, 0.8],
    lapLengthMeters: Number(lapLength.toFixed(2)),
    lapNodeIds: COURSE_NODE_IDS,
  },
  roads,
  buildings,
  landAreas,
  featureStats: {
    buildings: {
      total: buildings.length,
      heightSources: heightCounts,
    },
    landAreas: {
      total: landAreas.length,
      categories: landCounts,
    },
  },
};

await mkdir(new URL("../src/data/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../src/data/neighborhood.json", import.meta.url),
  `${JSON.stringify(fixture, null, 2)}\n`,
);

console.log(
  `道路中心線 ${roads.length} 本と ${fixture.course.lapLengthMeters} m の周回路を書き出しました。`,
);