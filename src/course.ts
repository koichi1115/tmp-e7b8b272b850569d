import fixtureData from "./data/neighborhood.json" with { type: "json" };
import type { FixtureData } from "./fixture.ts";

export type Vec2 = Readonly<{ x: number; y: number }>;

export type RoadLine = Readonly<{
  id: string;
  highway: string;
  points: readonly Vec2[];
}>;

export type BuildingHeightSource = "height" | "levels" | "default";

export type Building = Readonly<{
  id: string;
  height: number;
  heightSource: BuildingHeightSource;
  footprint: readonly Vec2[];
}>;

export type LandCategory = "park" | "grass" | "wood" | "water";

export type LandArea = Readonly<{
  id: string;
  category: LandCategory;
  points: readonly Vec2[];
}>;

export type Course = Readonly<{
  place: string;
  bboxLabel: string;
  width: number;
  height: number;
  roadWidth: number;
  roads: readonly RoadLine[];
  buildings: readonly Building[];
  landAreas: readonly LandArea[];
  lap: readonly Vec2[];
  lapCumulative: readonly number[];
  lapLength: number;
  checkpointFractions: readonly number[];
  /** 経由指定コースだけが持つ、通る順の交差点の位置。自動選出では空です。 */
  viaPoints: readonly Vec2[];
}>;

export type CoursePosition = Readonly<{
  point: Vec2;
  tangent: Vec2;
  distance: number;
  progress: number;
}>;

export type RoadPosition = Readonly<{
  point: Vec2;
  distance: number;
  road: RoadLine;
}>;

const required = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
};

const parseHeightSource = (source: string): BuildingHeightSource => {
  if (source === "height" || source === "levels" || source === "default") {
    return source;
  }
  throw new Error(`Unknown building height source ${source}.`);
};

const parseLandCategory = (category: string): LandCategory => {
  if (
    category === "park" ||
    category === "grass" ||
    category === "wood" ||
    category === "water"
  ) {
    return category;
  }
  throw new Error(`Unknown land category ${category}.`);
};

export const courseFromFixture = (data: FixtureData): Course => {
  if (
    data.schemaVersion !== 2 ||
    data.source.attribution !== "© OpenStreetMap contributors" ||
    data.source.license !== "ODbL 1.0"
  ) {
    throw new Error("Fixture metadata is invalid.");
  }
  const { bbox } = data;
  const latitudeRadians =
    (((bbox.south + bbox.north) / 2) * Math.PI) / 180;
  const metersPerLongitude =
    111_320 * Math.cos(latitudeRadians);
  const project = (latitude: number, longitude: number): Vec2 => ({
    x: (longitude - bbox.west) * metersPerLongitude,
    y: (bbox.north - latitude) * 111_320,
  });
  const projectAreaPoint = (
    point: readonly number[],
    owner: string,
  ): Vec2 => {
    const latitude = required(point[0], `${owner} has no latitude.`);
    const longitude = required(point[1], `${owner} has no longitude.`);
    return project(latitude, longitude);
  };

  const roads: RoadLine[] = data.roads.map((road) => ({
    id: road.id,
    highway: road.highway,
    points: road.points.map((point) =>
      project(point[1], point[2]),
    ),
  }));
  if (roads.length === 0) {
    throw new Error("Fixture has no roads.");
  }

  const buildings: Building[] = data.buildings.map((building) => ({
    id: building.id,
    height: building.heightMeters,
    heightSource: parseHeightSource(building.heightSource),
    footprint: building.points.map((point) =>
      projectAreaPoint(point, `Building ${building.id}`),
    ),
  }));

  const landAreas: LandArea[] = data.landAreas.map((area) => ({
    id: area.id,
    category: parseLandCategory(area.category),
    points: area.points.map((point) =>
      projectAreaPoint(point, `Land area ${area.id}`),
    ),
  }));

  const pointsByNode = new Map<number, Vec2>();
  const roadEdges = new Set<string>();
  for (const road of data.roads) {
    for (let index = 0; index < road.points.length; index += 1) {
      const point = road.points[index];
      if (!point) {
        continue;
      }
      pointsByNode.set(
        point[0],
        project(point[1], point[2]),
      );
      const previous = road.points[index - 1];
      if (previous) {
        roadEdges.add(
          previous[0] < point[0]
            ? `${previous[0]}:${point[0]}`
            : `${point[0]}:${previous[0]}`,
        );
      }
    }
  }

  if (
    data.course.lapNodeIds.length < 4 ||
    data.course.lapNodeIds[0] !== data.course.lapNodeIds.at(-1)
  ) {
    throw new Error("Fixture has no closed lap.");
  }
  for (let index = 1; index < data.course.lapNodeIds.length; index += 1) {
    const first = required(
      data.course.lapNodeIds[index - 1],
      "Lap edge has no start.",
    );
    const second = required(
      data.course.lapNodeIds[index],
      "Lap edge has no end.",
    );
    const key =
      first < second ? `${first}:${second}` : `${second}:${first}`;
    if (!roadEdges.has(key)) {
      throw new Error(`Lap edge ${key} is absent from roads.`);
    }
  }
  const lap = data.course.lapNodeIds.map((nodeId) =>
    required(pointsByNode.get(nodeId), `Lap node ${nodeId} is absent.`),
  );
  const lapCumulative = [0];
  for (let index = 1; index < lap.length; index += 1) {
    const first = required(lap[index - 1], "Lap segment has no start.");
    const second = required(lap[index], "Lap segment has no end.");
    lapCumulative.push(
      required(lapCumulative[index - 1], "Lap distance is absent.") +
        Math.hypot(second.x - first.x, second.y - first.y),
    );
  }
  const lapLength = required(
    lapCumulative[lapCumulative.length - 1],
    "Lap has no length.",
  );
  if (Math.abs(lapLength - data.course.lapLengthMeters) > 0.05) {
    throw new Error("Fixture lap length is inconsistent.");
  }

  const viaPoints = (data.course.viaNodeIds ?? []).map((nodeId) =>
    required(pointsByNode.get(nodeId), `Via node ${nodeId} is absent.`),
  );

  return {
    place: data.place,
    bboxLabel: `${bbox.south}, ${bbox.west}, ${bbox.north}, ${bbox.east}`,
    width: (bbox.east - bbox.west) * metersPerLongitude,
    height: (bbox.north - bbox.south) * 111_320,
    roadWidth: data.course.roadWidthMeters,
    roads,
    buildings,
    landAreas,
    lap,
    lapCumulative,
    lapLength,
    checkpointFractions: data.course.checkpointFractions,
    viaPoints,
  };
};

/**
 * 通過点の表示番号。経由コースでは1番目の経由点が出発地点なので、
 * チェックポイント i は経由 i+2 にあたります。
 */
export const checkpointLabel = (
  targetCourse: Course,
  index: number,
): string =>
  String(targetCourse.viaPoints.length > 0 ? index + 2 : index + 1);

/** 次に目指す経由点の番号（1始まり）。経由コースでない時は null。 */
export const nextViaNumber = (
  targetCourse: Course,
  checkpointsPassed: number,
): number | null => {
  const total = targetCourse.viaPoints.length;
  if (total === 0) {
    return null;
  }
  return checkpointsPassed + 2 <= total ? checkpointsPassed + 2 : 1;
};

export const course = courseFromFixture(
  fixtureData as unknown as FixtureData,
);

export const pointAtProgress = (
  targetCourse: Course,
  progress: number,
): CoursePosition => {
  const normalized = ((progress % 1) + 1) % 1;
  const distance = normalized * targetCourse.lapLength;
  let segmentIndex = 0;
  while (
    segmentIndex < targetCourse.lapCumulative.length - 2 &&
    required(
      targetCourse.lapCumulative[segmentIndex + 1],
      "Lap distance is absent.",
    ) < distance
  ) {
    segmentIndex += 1;
  }
  const first = required(
    targetCourse.lap[segmentIndex],
    "Lap segment has no start.",
  );
  const second = required(
    targetCourse.lap[segmentIndex + 1],
    "Lap segment has no end.",
  );
  const startDistance = required(
    targetCourse.lapCumulative[segmentIndex],
    "Lap distance is absent.",
  );
  const endDistance = required(
    targetCourse.lapCumulative[segmentIndex + 1],
    "Lap distance is absent.",
  );
  const segmentLength = endDistance - startDistance;
  const amount =
    segmentLength === 0 ? 0 : (distance - startDistance) / segmentLength;
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  return {
    point: {
      x: first.x + dx * amount,
      y: first.y + dy * amount,
    },
    tangent: {
      x: dx / segmentLength,
      y: dy / segmentLength,
    },
    distance: 0,
    progress: normalized,
  };
};

export const nearestCoursePosition = (
  targetCourse: Course,
  position: Vec2,
): CoursePosition => {
  let best: CoursePosition | null = null;
  for (let index = 1; index < targetCourse.lap.length; index += 1) {
    const first = required(
      targetCourse.lap[index - 1],
      "Lap segment has no start.",
    );
    const second = required(
      targetCourse.lap[index],
      "Lap segment has no end.",
    );
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const squaredLength = dx * dx + dy * dy;
    const amount =
      squaredLength === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((position.x - first.x) * dx + (position.y - first.y) * dy) /
                squaredLength,
            ),
          );
    const point = {
      x: first.x + dx * amount,
      y: first.y + dy * amount,
    };
    const distance = Math.hypot(position.x - point.x, position.y - point.y);
    const segmentLength = Math.sqrt(squaredLength);
    const progressDistance =
      required(
        targetCourse.lapCumulative[index - 1],
        "Lap distance is absent.",
      ) +
      segmentLength * amount;
    const candidate: CoursePosition = {
      point,
      tangent: {
        x: dx / segmentLength,
        y: dy / segmentLength,
      },
      distance,
      progress: progressDistance / targetCourse.lapLength,
    };
    if (best === null || candidate.distance < best.distance) {
      best = candidate;
    }
  }
  return required(best ?? undefined, "Lap has no segments.");
};

export const nearestRoadPosition = (
  targetCourse: Course,
  position: Vec2,
  accepts: (road: RoadLine) => boolean,
): RoadPosition | null => {
  let best: RoadPosition | null = null;
  for (const road of targetCourse.roads) {
    if (!accepts(road)) {
      continue;
    }
    for (let index = 1; index < road.points.length; index += 1) {
      const first = road.points[index - 1];
      const second = road.points[index];
      if (!first || !second) {
        continue;
      }
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const squaredLength = dx * dx + dy * dy;
      const amount =
        squaredLength === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                1,
                ((position.x - first.x) * dx +
                  (position.y - first.y) * dy) /
                  squaredLength,
              ),
            );
      const point = {
        x: first.x + dx * amount,
        y: first.y + dy * amount,
      };
      const candidate: RoadPosition = {
        point,
        distance: Math.hypot(position.x - point.x, position.y - point.y),
        road,
      };
      if (best === null || candidate.distance < best.distance) {
        best = candidate;
      }
    }
  }
  return best;
};

