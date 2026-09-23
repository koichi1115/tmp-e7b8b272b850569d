import type {
  Bbox,
  FixtureAreaPoint,
  FixtureBuilding,
  FixtureData,
  FixtureLandArea,
  FixtureRoad,
  FixtureRoadPoint,
} from "./fixture.ts";

export const MAX_BBOX_AREA_M2 = 500_000;
/** 自動選出コースの通過点。経由指定では経由点そのものを使います。 */
export const DEFAULT_CHECKPOINT_FRACTIONS: readonly number[] = [
  0.2, 0.4, 0.6, 0.8,
];
export const OVERPASS_ENDPOINT =
  "https://overpass.private.coffee/api/interpreter";

const DISPLAY_TYPES = new Set([
  "living_street",
  "residential",
  "service",
  "secondary",
  "tertiary",
  "unclassified",
]);
/** 周回路に使える道路種別。経由コース（via-lap.ts）と共有します。 */
export const LAP_HIGHWAY_TYPES: ReadonlySet<string> = new Set([
  "residential",
  "tertiary",
  "unclassified",
]);

type OsmPoint = Readonly<{ lat: number; lon: number }>;
type OsmWay = Readonly<{
  type: "way";
  id: number;
  nodes: readonly number[];
  geometry: readonly OsmPoint[];
  tags: Readonly<Record<string, string>>;
}>;
type OverpassPayload = Readonly<{ elements?: readonly unknown[] }>;
type GraphEdge = Readonly<{
  first: number;
  second: number;
  length: number;
  key: string;
}>;

export class RangePreparationError extends Error {
  readonly code: "bbox" | "no_roads" | "no_cycle" | "response";

  constructor(
    code: "bbox" | "no_roads" | "no_cycle" | "response",
    message: string,
  ) {
    super(message);
    this.name = "RangePreparationError";
    this.code = code;
  }
}

export const bboxSize = (bbox: Bbox) => {
  const latitudeRadians =
    (((bbox.south + bbox.north) / 2) * Math.PI) / 180;
  const width =
    (bbox.east - bbox.west) *
    111_320 *
    Math.cos(latitudeRadians);
  const height = (bbox.north - bbox.south) * 111_320;
  return { width, height, area: width * height };
};

export const validateBbox = (bbox: Bbox): void => {
  const values = [bbox.south, bbox.west, bbox.north, bbox.east];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    bbox.south < -85 ||
    bbox.north > 85 ||
    bbox.west < -180 ||
    bbox.east > 180 ||
    bbox.south >= bbox.north ||
    bbox.west >= bbox.east
  ) {
    throw new RangePreparationError(
      "bbox",
      "境界範囲の座標が正しくありません。",
    );
  }
  const size = bboxSize(bbox);
  if (size.width < 80 || size.height < 80) {
    throw new RangePreparationError(
      "bbox",
      "境界範囲は縦横とも80 m以上にしてください。",
    );
  }
  if (size.area > MAX_BBOX_AREA_M2) {
    throw new RangePreparationError(
      "bbox",
      "境界範囲が上限の0.50 km²を超えています。",
    );
  }
};

export const buildOverpassQuery = (bbox: Bbox): string =>
  `[out:json][timeout:90];(way[highway](${bbox.south},${bbox.west},${bbox.north},${bbox.east});way[building](${bbox.south},${bbox.west},${bbox.north},${bbox.east});way[landuse](${bbox.south},${bbox.west},${bbox.north},${bbox.east});way[leisure](${bbox.south},${bbox.west},${bbox.north},${bbox.east});way[natural](${bbox.south},${bbox.west},${bbox.north},${bbox.east});way[water](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out geom;`;

const parseWays = (payload: OverpassPayload): OsmWay[] => {
  if (!Array.isArray(payload.elements)) {
    throw new RangePreparationError(
      "response",
      "道路データの応答形式が正しくありません。",
    );
  }
  return payload.elements
    .filter((element): element is OsmWay => {
      if (typeof element !== "object" || element === null) {
        return false;
      }
      const candidate = element as Partial<OsmWay>;
      return (
        candidate.type === "way" &&
        typeof candidate.id === "number" &&
        Array.isArray(candidate.nodes) &&
        Array.isArray(candidate.geometry) &&
        typeof candidate.tags === "object" &&
        candidate.tags !== null
      );
    })
    .sort((left, right) => left.id - right.id);
};

const isInside = (bbox: Bbox, point: OsmPoint): boolean =>
  point.lat >= bbox.south &&
  point.lat <= bbox.north &&
  point.lon >= bbox.west &&
  point.lon <= bbox.east;

const sameCoordinate = (first: OsmPoint, second: OsmPoint): boolean =>
  first.lat === second.lat && first.lon === second.lon;

const interpolateAt = (
  first: OsmPoint,
  second: OsmPoint,
  axis: "lat" | "lon",
  boundary: number,
): OsmPoint => {
  const amount =
    (boundary - first[axis]) / (second[axis] - first[axis]);
  return {
    lat: first.lat + (second.lat - first.lat) * amount,
    lon: first.lon + (second.lon - first.lon) * amount,
  };
};

const clipEdge = (
  points: readonly OsmPoint[],
  inside: (point: OsmPoint) => boolean,
  intersection: (first: OsmPoint, second: OsmPoint) => OsmPoint,
): OsmPoint[] => {
  const clipped: OsmPoint[] = [];
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

const clipPolygon = (
  bbox: Bbox,
  geometry: readonly OsmPoint[],
): readonly FixtureAreaPoint[] => {
  let points = geometry.slice(0, -1);
  points = clipEdge(
    points,
    (point) => point.lon >= bbox.west,
    (first, second) => interpolateAt(first, second, "lon", bbox.west),
  );
  points = clipEdge(
    points,
    (point) => point.lon <= bbox.east,
    (first, second) => interpolateAt(first, second, "lon", bbox.east),
  );
  points = clipEdge(
    points,
    (point) => point.lat >= bbox.south,
    (first, second) => interpolateAt(first, second, "lat", bbox.south),
  );
  points = clipEdge(
    points,
    (point) => point.lat <= bbox.north,
    (first, second) => interpolateAt(first, second, "lat", bbox.north),
  );
  if (points.length < 3) {
    return [];
  }
  return [...points, points[0]!].map(
    (point) => [point.lat, point.lon] as const,
  );
};

const parsePositiveNumber = (value: string | undefined): number | null => {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(?:m)?$/i);
  const number = Number(match?.[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const buildingHeight = (
  tags: Readonly<Record<string, string>>,
): Pick<FixtureBuilding, "heightMeters" | "heightSource"> => {
  const height = parsePositiveNumber(tags.height);
  if (height !== null && height <= 150) {
    return { heightMeters: height, heightSource: "height" };
  }
  const levels = parsePositiveNumber(tags["building:levels"]);
  if (levels !== null && levels <= 50) {
    return { heightMeters: levels * 3, heightSource: "levels" };
  }
  return { heightMeters: 6, heightSource: "default" };
};

const landCategory = (
  tags: Readonly<Record<string, string>>,
): FixtureLandArea["category"] | null => {
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

const collectRoads = (
  ways: readonly OsmWay[],
  bbox: Bbox,
): FixtureRoad[] => {
  const roads: FixtureRoad[] = [];
  for (const way of ways) {
    const highway = way.tags.highway;
    if (!highway || !DISPLAY_TYPES.has(highway)) {
      continue;
    }
    let part: FixtureRoadPoint[] = [];
    let partIndex = 0;
    const flush = () => {
      if (part.length >= 2) {
        roads.push({
          id: `${way.id}:${partIndex}`,
          osmWayId: way.id,
          highway,
          name: way.tags.name ?? null,
          points: part,
        });
        partIndex += 1;
      }
      part = [];
    };
    for (let index = 0; index < way.nodes.length; index += 1) {
      const point = way.geometry[index];
      const nodeId = way.nodes[index];
      if (point && nodeId !== undefined && isInside(bbox, point)) {
        part.push([nodeId, point.lat, point.lon]);
      } else {
        flush();
      }
    }
    flush();
  }
  return roads;
};

const normalizeCycle = (
  closedCycle: readonly number[],
  pointsByNode: ReadonlyMap<number, FixtureRoadPoint>,
): number[] => {
  const cycle = closedCycle.slice(0, -1);
  let startIndex = 0;
  for (let index = 1; index < cycle.length; index += 1) {
    const point = pointsByNode.get(cycle[index]!);
    const start = pointsByNode.get(cycle[startIndex]!);
    if (
      point &&
      start &&
      (point[1] < start[1] ||
        (point[1] === start[1] && point[2] < start[2]))
    ) {
      startIndex = index;
    }
  }
  const rotated = [
    ...cycle.slice(startIndex),
    ...cycle.slice(0, startIndex),
  ];
  const next = pointsByNode.get(rotated[1]!);
  const previous = pointsByNode.get(rotated.at(-1)!);
  if (next && previous && next[2] < previous[2]) {
    rotated.reverse();
    const restoredStart = rotated.indexOf(cycle[startIndex]!);
    rotated.push(...rotated.splice(0, restoredStart));
  }
  return [...rotated, rotated[0]!];
};

export const generateLap = (
  roads: readonly FixtureRoad[],
  bbox: Bbox,
) => {
  const latitudeRadians =
    (((bbox.south + bbox.north) / 2) * Math.PI) / 180;
  const project = (point: FixtureRoadPoint) => ({
    x:
      (point[2] - bbox.west) *
      111_320 *
      Math.cos(latitudeRadians),
    y: (bbox.north - point[1]) * 111_320,
  });
  const pointsByNode = new Map<number, FixtureRoadPoint>();
  const edgeByKey = new Map<string, GraphEdge>();
  const adjacency = new Map<
    number,
    { to: number; edge: GraphEdge }[]
  >();

  for (const road of roads) {
    if (!LAP_HIGHWAY_TYPES.has(road.highway)) {
      continue;
    }
    for (let index = 1; index < road.points.length; index += 1) {
      const firstPoint = road.points[index - 1];
      const secondPoint = road.points[index];
      if (!firstPoint || !secondPoint) {
        continue;
      }
      const first = firstPoint[0];
      const second = secondPoint[0];
      const key =
        first < second ? `${first}:${second}` : `${second}:${first}`;
      pointsByNode.set(first, firstPoint);
      pointsByNode.set(second, secondPoint);
      if (!edgeByKey.has(key)) {
        const a = project(firstPoint);
        const b = project(secondPoint);
        edgeByKey.set(key, {
          first,
          second,
          key,
          length: Math.hypot(a.x - b.x, a.y - b.y),
        });
      }
    }
  }
  if (edgeByKey.size === 0) {
    throw new RangePreparationError(
      "no_roads",
      "走行できる道路が範囲内にありません。",
    );
  }

  const edges = [...edgeByKey.values()].sort(
    (left, right) =>
      left.first - right.first || left.second - right.second,
  );
  for (const edge of edges) {
    for (const [from, to] of [
      [edge.first, edge.second],
      [edge.second, edge.first],
    ] as const) {
      const neighbors = adjacency.get(from) ?? [];
      neighbors.push({ to, edge });
      adjacency.set(from, neighbors);
    }
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) => left.to - right.to);
  }
  const sortedNodes = [...adjacency.keys()].sort(
    (left, right) => left - right,
  );

  const shortestPathWithout = (
    start: number,
    finish: number,
    excluded: GraphEdge,
  ): { path: number[]; length: number } | null => {
    const distances = new Map([[start, 0]]);
    const previous = new Map<number, number>();
    const remaining = new Set(sortedNodes);
    while (remaining.size > 0) {
      let current: number | null = null;
      let currentDistance = Number.POSITIVE_INFINITY;
      for (const nodeId of remaining) {
        const distance =
          distances.get(nodeId) ?? Number.POSITIVE_INFINITY;
        if (distance < currentDistance) {
          current = nodeId;
          currentDistance = distance;
        }
      }
      if (current === null || !Number.isFinite(currentDistance)) {
        break;
      }
      remaining.delete(current);
      if (current === finish) {
        break;
      }
      for (const neighbor of adjacency.get(current) ?? []) {
        if (neighbor.edge === excluded) {
          continue;
        }
        const candidate = currentDistance + neighbor.edge.length;
        if (
          candidate <
          (distances.get(neighbor.to) ?? Number.POSITIVE_INFINITY)
        ) {
          distances.set(neighbor.to, candidate);
          previous.set(neighbor.to, current);
        }
      }
    }
    const length = distances.get(finish);
    if (length === undefined) {
      return null;
    }
    const path = [finish];
    while (path.at(-1) !== start) {
      const prior = previous.get(path.at(-1) as number);
      if (prior === undefined) {
        return null;
      }
      path.push(prior);
    }
    path.reverse();
    return { path, length };
  };

  const candidates = new Map<
    string,
    { cycle: number[]; length: number; turns: number }
  >();
  for (const edge of edges) {
    const alternate = shortestPathWithout(
      edge.first,
      edge.second,
      edge,
    );
    if (!alternate) {
      continue;
    }
    const cycle = [...alternate.path, edge.first];
    const length = alternate.length + edge.length;
    if (
      length < 120 ||
      length > 1_500 ||
      cycle.length < 7
    ) {
      continue;
    }
    const edgeKeys: string[] = [];
    let turns = 0;
    for (let index = 1; index < cycle.length; index += 1) {
      const first = cycle[index - 1]!;
      const second = cycle[index]!;
      edgeKeys.push(
        first < second ? `${first}:${second}` : `${second}:${first}`,
      );
    }
    for (let index = 0; index < cycle.length - 1; index += 1) {
      const previousId =
        cycle[
          (index - 1 + cycle.length - 1) % (cycle.length - 1)
        ]!;
      const currentId = cycle[index]!;
      const nextId = cycle[(index + 1) % (cycle.length - 1)]!;
      const previous = project(pointsByNode.get(previousId)!);
      const current = project(pointsByNode.get(currentId)!);
      const next = project(pointsByNode.get(nextId)!);
      const incoming = Math.atan2(
        current.y - previous.y,
        current.x - previous.x,
      );
      const outgoing = Math.atan2(
        next.y - current.y,
        next.x - current.x,
      );
      const turn = Math.abs(
        Math.atan2(
          Math.sin(outgoing - incoming),
          Math.cos(outgoing - incoming),
        ),
      );
      if (turn >= (20 * Math.PI) / 180) {
        turns += 1;
      }
    }
    const key = edgeKeys.sort().join("|");
    if (!candidates.has(key)) {
      candidates.set(key, { cycle, length, turns });
    }
  }
  const selected = [...candidates.entries()].sort(
    ([leftKey, left], [rightKey, right]) =>
      Math.abs(left.length - 500) - Math.abs(right.length - 500) ||
      right.turns - left.turns ||
      leftKey.localeCompare(rightKey),
  )[0]?.[1];
  if (!selected) {
    throw new RangePreparationError(
      "no_cycle",
      "閉じた周回路を道路グラフから作れませんでした。",
    );
  }
  const lapNodeIds = normalizeCycle(
    selected.cycle,
    pointsByNode,
  );
  return {
    lapNodeIds,
    lapLengthMeters: Number(selected.length.toFixed(2)),
  };
};

const requireRoads = (
  ways: readonly OsmWay[],
  bbox: Bbox,
): FixtureRoad[] => {
  const roads = collectRoads(ways, bbox);
  if (roads.length === 0) {
    throw new RangePreparationError(
      "no_roads",
      "道路が範囲内にありません。",
    );
  }
  return roads;
};

/** 応答から走行可能な道路だけを取り出します。周回路はまだ決めません。 */
export const prepareRoads = (
  payload: OverpassPayload,
  bbox: Bbox,
): readonly FixtureRoad[] => {
  validateBbox(bbox);
  return requireRoads(parseWays(payload), bbox);
};

export type PreparedCourse = Readonly<{
  lapNodeIds: readonly number[];
  lapLengthMeters: number;
  checkpointFractions?: readonly number[];
  viaNodeIds?: readonly number[];
}>;

export const prepareFixture = (
  payload: OverpassPayload,
  bbox: Bbox,
  metadata: Readonly<{
    place: string;
    capturedAt: string;
    endpoint?: string;
    query?: string;
  }>,
  options: Readonly<{ lap?: PreparedCourse }> = {},
): FixtureData => {
  validateBbox(bbox);
  const ways = parseWays(payload);
  const roads = requireRoads(ways, bbox);
  // 経由指定のコースが渡された時だけ、自動選出をしません。
  const course: PreparedCourse = options.lap ?? generateLap(roads, bbox);
  const closedWays = ways.filter((way) => {
    const first = way.geometry[0];
    const last = way.geometry.at(-1);
    return first && last && sameCoordinate(first, last);
  });
  const buildings: FixtureBuilding[] = [];
  const heightSources = { height: 0, levels: 0, default: 0 };
  const landAreas: FixtureLandArea[] = [];
  const landCategories = { park: 0, grass: 0, wood: 0, water: 0 };
  for (const way of closedWays) {
    if (typeof way.tags.building === "string") {
      const points = clipPolygon(bbox, way.geometry);
      if (points.length >= 4) {
        const height = buildingHeight(way.tags);
        heightSources[height.heightSource] += 1;
        buildings.push({
          id: `way/${way.id}`,
          osmWayId: way.id,
          ...height,
          points,
        });
      }
      continue;
    }
    const category = landCategory(way.tags);
    if (category) {
      const points = clipPolygon(bbox, way.geometry);
      if (points.length >= 4) {
        landCategories[category] += 1;
        landAreas.push({
          id: `way/${way.id}`,
          osmWayId: way.id,
          category,
          points,
        });
      }
    }
  }
  const query = metadata.query ?? buildOverpassQuery(bbox);
  return {
    schemaVersion: 2,
    place: metadata.place,
    bbox,
    snapshot: metadata.capturedAt,
    source: {
      name: "OpenStreetMap",
      endpoint: metadata.endpoint ?? OVERPASS_ENDPOINT,
      fallbackEndpoints: [OVERPASS_ENDPOINT],
      query,
      attribution: "© OpenStreetMap contributors",
      license: "ODbL 1.0",
    },
    course: {
      roadWidthMeters: 14,
      checkpointFractions:
        course.checkpointFractions ?? DEFAULT_CHECKPOINT_FRACTIONS,
      lapLengthMeters: course.lapLengthMeters,
      lapNodeIds: course.lapNodeIds,
      ...(course.viaNodeIds ? { viaNodeIds: course.viaNodeIds } : {}),
    },
    roads,
    buildings,
    landAreas,
    featureStats: {
      buildings: {
        total: buildings.length,
        heightSources,
      },
      landAreas: {
        total: landAreas.length,
        categories: landCategories,
      },
    },
  };
};