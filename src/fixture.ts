export type Bbox = Readonly<{
  south: number;
  west: number;
  north: number;
  east: number;
}>;

export type FixtureRoadPoint = readonly [
  nodeId: number,
  latitude: number,
  longitude: number,
];

export type FixtureAreaPoint = readonly [
  latitude: number,
  longitude: number,
];

export type FixtureRoad = Readonly<{
  id: string;
  osmWayId: number;
  highway: string;
  name: string | null;
  points: readonly FixtureRoadPoint[];
}>;

export type FixtureBuilding = Readonly<{
  id: string;
  osmWayId: number;
  heightMeters: number;
  heightSource: "height" | "levels" | "default";
  points: readonly FixtureAreaPoint[];
}>;

export type FixtureLandArea = Readonly<{
  id: string;
  osmWayId: number;
  category: "park" | "grass" | "wood" | "water";
  points: readonly FixtureAreaPoint[];
}>;

export type FixtureData = Readonly<{
  schemaVersion: 2;
  place: string;
  bbox: Bbox;
  snapshot: string;
  source: Readonly<{
    name: string;
    endpoint: string;
    fallbackEndpoints: readonly string[];
    query: string;
    attribution: string;
    license: string;
  }>;
  course: Readonly<{
    roadWidthMeters: number;
    checkpointFractions: readonly number[];
    lapLengthMeters: number;
    lapNodeIds: readonly number[];
    /** 経由指定で作ったコースだけが持つ、通る順の交差点。 */
    viaNodeIds?: readonly number[];
  }>;
  roads: readonly FixtureRoad[];
  buildings: readonly FixtureBuilding[];
  landAreas: readonly FixtureLandArea[];
  featureStats: Readonly<{
    buildings: Readonly<{
      total: number;
      heightSources: Readonly<{
        height: number;
        levels: number;
        default: number;
      }>;
    }>;
    landAreas: Readonly<{
      total: number;
      categories: Readonly<{
        park: number;
        grass: number;
        wood: number;
        water: number;
      }>;
    }>;
  }>;
}>;

export const PREPARED_FIXTURE_KEY =
  "kinjo-race:prepared-fixture:v1";