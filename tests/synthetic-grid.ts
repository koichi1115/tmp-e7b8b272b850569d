/**
 * 試験用の合成道路グラフ。Overpass へは一切触れません。
 * 行と列をそれぞれ1本の道路（way）にした格子を作ります。
 */
import type {
  Bbox,
  FixtureData,
  FixtureRoad,
  FixtureRoadPoint,
} from "../src/fixture.ts";

export type Grid = Readonly<{
  roads: readonly FixtureRoad[];
  bbox: Bbox;
  nodeId: (row: number, column: number) => number;
  spacingMeters: number;
}>;

export const gridGraph = (
  rows: number,
  columns: number,
  spacingMeters: number,
  origin: Readonly<{ latitude: number; longitude: number }> = {
    latitude: 35.7,
    longitude: 139.65,
  },
): Grid => {
  const latitudeStep = spacingMeters / 111_320;
  const longitudeStep =
    spacingMeters /
    (111_320 * Math.cos((origin.latitude * Math.PI) / 180));
  const nodeId = (row: number, column: number) => row * 100 + column + 1;
  const point = (row: number, column: number): FixtureRoadPoint => [
    nodeId(row, column),
    origin.latitude + (rows - 1 - row) * latitudeStep,
    origin.longitude + column * longitudeStep,
  ];
  const roads: FixtureRoad[] = [];
  for (let row = 0; row < rows; row += 1) {
    roads.push({
      id: `row-${row}`,
      osmWayId: 1_000 + row,
      highway: "residential",
      name: null,
      points: Array.from({ length: columns }, (_, column) =>
        point(row, column),
      ),
    });
  }
  for (let column = 0; column < columns; column += 1) {
    roads.push({
      id: `column-${column}`,
      osmWayId: 2_000 + column,
      highway: "residential",
      name: null,
      points: Array.from({ length: rows }, (_, row) => point(row, column)),
    });
  }
  const margin = latitudeStep / 2;
  return {
    roads,
    bbox: {
      south: origin.latitude - margin,
      west: origin.longitude - longitudeStep / 2,
      north: origin.latitude + (rows - 1) * latitudeStep + margin,
      east:
        origin.longitude +
        (columns - 1) * longitudeStep +
        longitudeStep / 2,
    },
    nodeId,
    spacingMeters,
  };
};

/** 二つの独立した十字路。橋渡しの道はありません。 */
export const disconnectedGraph = (): Readonly<{
  roads: readonly FixtureRoad[];
  bbox: Bbox;
  firstCenter: number;
  secondCenter: number;
}> => {
  const cross = (
    base: number,
    latitude: number,
    longitude: number,
  ): FixtureRoad[] => {
    const step = 0.0005;
    return [
      {
        id: `cross-${base}-h`,
        osmWayId: base,
        highway: "residential",
        name: null,
        points: [
          [base + 1, latitude, longitude - step],
          [base, latitude, longitude],
          [base + 2, latitude, longitude + step],
        ],
      },
      {
        id: `cross-${base}-v`,
        osmWayId: base + 1,
        highway: "residential",
        name: null,
        points: [
          [base + 3, latitude - step, longitude],
          [base, latitude, longitude],
          [base + 4, latitude + step, longitude],
        ],
      },
    ];
  };
  return {
    roads: [
      ...cross(100, 35.7, 139.65),
      ...cross(200, 35.702, 139.654),
    ],
    bbox: {
      south: 35.6985,
      west: 139.6485,
      north: 35.7035,
      east: 139.6555,
    },
    firstCenter: 100,
    secondCenter: 200,
  };
};

export const syntheticFixture = (
  roads: readonly FixtureRoad[],
  bbox: Bbox,
  course: FixtureData["course"],
): FixtureData => ({
  schemaVersion: 2,
  place: "合成試験範囲",
  bbox,
  snapshot: "2026-09-23T00:00:00Z",
  source: {
    name: "OpenStreetMap",
    endpoint: "https://example.invalid/interpreter",
    fallbackEndpoints: [],
    query: "(synthetic)",
    attribution: "© OpenStreetMap contributors",
    license: "ODbL 1.0",
  },
  course,
  roads,
  buildings: [],
  landAreas: [],
  featureStats: {
    buildings: {
      total: 0,
      heightSources: { height: 0, levels: 0, default: 0 },
    },
    landAreas: {
      total: 0,
      categories: { park: 0, grass: 0, wood: 0, water: 0 },
    },
  },
});
