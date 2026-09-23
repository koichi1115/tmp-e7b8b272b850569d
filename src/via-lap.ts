/**
 * 経由点（交差点）を指定された順に通る閉じた周回路を作ります。
 * DOM も通信も持たない純粋モジュールです。
 */
import { LAP_HIGHWAY_TYPES } from "./free-range.ts";
import type {
  Bbox,
  FixtureData,
  FixtureRoad,
} from "./fixture.ts";

export type ViaCourseErrorCode =
  | "via_count"
  | "not_intersection"
  | "duplicate_via"
  | "unreachable"
  | "lap_length";

export class ViaCourseError extends Error {
  readonly code: ViaCourseErrorCode;

  constructor(code: ViaCourseErrorCode, message: string) {
    super(`${message}（${code}）`);
    this.name = "ViaCourseError";
    this.code = code;
  }
}

/** 経由点に選べるのは交差点、つまり次数3以上の節点です。 */
export const MIN_INTERSECTION_DEGREE = 3;
export const MIN_VIA_COUNT = 2;
/** 自動選出 generateLap と同じ周回長の規則です。 */
export const MIN_LAP_LENGTH_METERS = 120;
export const MAX_LAP_LENGTH_METERS = 1_500;

export type ViaNode = Readonly<{
  nodeId: number;
  latitude: number;
  longitude: number;
  degree: number;
}>;

type Neighbor = Readonly<{ to: number; key: string; length: number }>;

export type ViaGraph = Readonly<{
  bbox: Bbox;
  nodes: ReadonlyMap<number, ViaNode>;
  positions: ReadonlyMap<number, Readonly<{ x: number; y: number }>>;
  adjacency: ReadonlyMap<number, readonly Neighbor[]>;
  edgeKeys: ReadonlySet<string>;
}>;

export type ViaLap = Readonly<{
  lapNodeIds: readonly number[];
  lapLengthMeters: number;
  checkpointFractions: readonly number[];
  viaNodeIds: readonly number[];
}>;

const edgeKey = (first: number, second: number): string =>
  first < second ? `${first}:${second}` : `${second}:${first}`;

export const buildViaGraph = (
  roads: readonly FixtureRoad[],
  bbox: Bbox,
): ViaGraph => {
  const latitudeRadians =
    (((bbox.south + bbox.north) / 2) * Math.PI) / 180;
  const metersPerLongitude = 111_320 * Math.cos(latitudeRadians);
  const nodes = new Map<number, ViaNode>();
  const positions = new Map<number, { x: number; y: number }>();
  const adjacency = new Map<number, Neighbor[]>();
  const edgeKeys = new Set<string>();

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
      for (const point of [firstPoint, secondPoint]) {
        nodes.set(point[0], {
          nodeId: point[0],
          latitude: point[1],
          longitude: point[2],
          degree: 0,
        });
        positions.set(point[0], {
          x: (point[2] - bbox.west) * metersPerLongitude,
          y: (bbox.north - point[1]) * 111_320,
        });
      }
      const key = edgeKey(firstPoint[0], secondPoint[0]);
      if (edgeKeys.has(key) || firstPoint[0] === secondPoint[0]) {
        continue;
      }
      edgeKeys.add(key);
      const first = positions.get(firstPoint[0])!;
      const second = positions.get(secondPoint[0])!;
      const length = Math.hypot(second.x - first.x, second.y - first.y);
      for (const [from, to] of [
        [firstPoint[0], secondPoint[0]],
        [secondPoint[0], firstPoint[0]],
      ] as const) {
        const neighbors = adjacency.get(from) ?? [];
        neighbors.push({ to, key, length });
        adjacency.set(from, neighbors);
      }
    }
  }
  for (const [nodeId, neighbors] of adjacency) {
    neighbors.sort((left, right) => left.to - right.to);
    const node = nodes.get(nodeId);
    if (node) {
      nodes.set(nodeId, { ...node, degree: neighbors.length });
    }
  }
  return { bbox, nodes, positions, adjacency, edgeKeys };
};

export const intersectionNodes = (graph: ViaGraph): readonly ViaNode[] =>
  [...graph.nodes.values()]
    .filter((node) => node.degree >= MIN_INTERSECTION_DEGREE)
    .sort((left, right) => left.nodeId - right.nodeId);

/** 使用済みの辺を避ける最短路。同点は節点番号の小さい側に決めます。 */
const shortestPath = (
  graph: ViaGraph,
  start: number,
  finish: number,
  excluded: ReadonlySet<string>,
): readonly number[] | null => {
  const sortedNodes = [...graph.adjacency.keys()].sort(
    (left, right) => left - right,
  );
  const distances = new Map<number, number>([[start, 0]]);
  const previous = new Map<number, number>();
  const remaining = new Set(sortedNodes);
  while (remaining.size > 0) {
    let current: number | null = null;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const nodeId of sortedNodes) {
      if (!remaining.has(nodeId)) {
        continue;
      }
      const distance = distances.get(nodeId) ?? Number.POSITIVE_INFINITY;
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
    for (const neighbor of graph.adjacency.get(current) ?? []) {
      if (excluded.has(neighbor.key)) {
        continue;
      }
      const candidate = currentDistance + neighbor.length;
      if (
        candidate <
        (distances.get(neighbor.to) ?? Number.POSITIVE_INFINITY)
      ) {
        distances.set(neighbor.to, candidate);
        previous.set(neighbor.to, current);
      }
    }
  }
  if (distances.get(finish) === undefined) {
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
  return path.reverse();
};

/**
 * 経由点を指定順に結び、最後の点から最初の点へ戻る閉路を作ります。
 * 一度走った道は使い回さないので、往復ではない本当の周回路になります。
 */
export const buildViaLap = (
  graph: ViaGraph,
  viaNodeIds: readonly number[],
): ViaLap => {
  if (viaNodeIds.length < MIN_VIA_COUNT) {
    throw new ViaCourseError(
      "via_count",
      `経由する交差点が足りません。${MIN_VIA_COUNT}つ以上えらんでください`,
    );
  }
  const intersections = new Set(
    intersectionNodes(graph).map((node) => node.nodeId),
  );
  for (const nodeId of viaNodeIds) {
    if (!intersections.has(nodeId)) {
      throw new ViaCourseError(
        "not_intersection",
        `節点 ${nodeId} は準備した道路グラフの交差点ではありません`,
      );
    }
  }
  for (let index = 0; index < viaNodeIds.length; index += 1) {
    const current = viaNodeIds[index]!;
    const next = viaNodeIds[(index + 1) % viaNodeIds.length]!;
    if (current === next) {
      throw new ViaCourseError(
        "duplicate_via",
        `${index + 1}番目と次の経由点が同じ交差点です`,
      );
    }
  }

  const lapNodeIds: number[] = [viaNodeIds[0]!];
  const viaLapIndexes: number[] = [0];
  const used = new Set<string>();
  for (let index = 0; index < viaNodeIds.length; index += 1) {
    const from = viaNodeIds[index]!;
    const to = viaNodeIds[(index + 1) % viaNodeIds.length]!;
    const path = shortestPath(graph, from, to, used);
    if (!path) {
      throw new ViaCourseError(
        "unreachable",
        `経由 ${index + 1} から ${((index + 1) % viaNodeIds.length) + 1} へ通り抜けられる道がありません`,
      );
    }
    for (let step = 1; step < path.length; step += 1) {
      used.add(edgeKey(path[step - 1]!, path[step]!));
      lapNodeIds.push(path[step]!);
    }
    if (index + 1 < viaNodeIds.length) {
      viaLapIndexes.push(lapNodeIds.length - 1);
    }
  }

  const cumulative = [0];
  for (let index = 1; index < lapNodeIds.length; index += 1) {
    const first = graph.positions.get(lapNodeIds[index - 1]!)!;
    const second = graph.positions.get(lapNodeIds[index]!)!;
    cumulative.push(
      cumulative[index - 1]! +
        Math.hypot(second.x - first.x, second.y - first.y),
    );
  }
  const lapLength = cumulative.at(-1)!;
  if (
    lapNodeIds.length < 4 ||
    lapLength < MIN_LAP_LENGTH_METERS ||
    lapLength > MAX_LAP_LENGTH_METERS
  ) {
    throw new ViaCourseError(
      "lap_length",
      `周回路は ${MIN_LAP_LENGTH_METERS}〜${MAX_LAP_LENGTH_METERS} mにしてください。いまは ${lapLength.toFixed(0)} mです`,
    );
  }

  const checkpointFractions = viaLapIndexes
    .slice(1)
    .map((index) => cumulative[index]! / lapLength);
  let previous = 0;
  for (const fraction of checkpointFractions) {
    if (!(fraction > previous) || fraction >= 1) {
      throw new ViaCourseError(
        "duplicate_via",
        "経由点が同じ地点に重なっています",
      );
    }
    previous = fraction;
  }

  return {
    lapNodeIds,
    lapLengthMeters: Number(lapLength.toFixed(2)),
    checkpointFractions,
    viaNodeIds: [...viaNodeIds],
  };
};

/** 準備済み fixture のコースだけを経由コースへ差し替えます。 */
export const withViaCourse = (
  fixture: FixtureData,
  lap: ViaLap,
): FixtureData => ({
  ...fixture,
  course: {
    ...fixture.course,
    checkpointFractions: lap.checkpointFractions,
    lapLengthMeters: lap.lapLengthMeters,
    lapNodeIds: lap.lapNodeIds,
    viaNodeIds: lap.viaNodeIds,
  },
});
