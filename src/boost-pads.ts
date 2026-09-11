import {
  nearestCoursePosition,
  pointAtProgress,
  type Course,
  type Vec2,
} from "./course.ts";
import { vehicleMaxSpeed, type VehicleId } from "./vehicles.ts";

export const BOOST_PADS_KEY = "kinjo-race:boost-pads:v1";

export const PAD_LENGTH_METERS = 6;
export const PAD_WIDTH_METERS = 9;
export const PAD_CORRIDOR_MARGIN_METERS = 1.2;
export const PAD_MIN_SEPARATION_METERS = 12;
export const GATE_CLEARANCE_METERS = 14;

export const BOOST_MULTIPLIER = 1.6;
export const BOOST_DURATION_MS = 1_800;
export const BOOST_ACCELERATION = 26;
export const HARD_SPEED_CAP_MPS = 24;

export type BoostPad = Readonly<{
  id: string;
  x: number;
  y: number;
  heading: number;
}>;

export type PadRejection = "corridor" | "pad" | "gate";

export type PadPlacement =
  | Readonly<{ accepted: true; pad: BoostPad }>
  | Readonly<{ accepted: false; reason: PadRejection; message: string }>;

export const PAD_REJECTION_MESSAGES: Readonly<
  Record<PadRejection, string>
> = {
  corridor: "コースの路面から外れています。黄色い周回路の上へ戻ってください。",
  pad: "近くに加速パッドがあります。12 m以上離してください。",
  gate: "ゲートに近すぎます。ゲートから14 m以上離してください。",
};

export const boostedSpeedCap = (vehicleId: VehicleId): number =>
  Math.min(
    HARD_SPEED_CAP_MPS,
    vehicleMaxSpeed(vehicleId) * BOOST_MULTIPLIER,
  );

export const clampBoostedSpeed = (
  speed: number,
  vehicleId: VehicleId,
  maximumReverseSpeed = -6,
): number =>
  Math.max(
    maximumReverseSpeed,
    Math.min(boostedSpeedCap(vehicleId), speed),
  );

export const gatePositions = (targetCourse: Course): readonly Vec2[] =>
  [0, ...targetCourse.checkpointFractions].map(
    (fraction) => pointAtProgress(targetCourse, fraction).point,
  );

export const nextPadId = (pads: readonly BoostPad[]): string => {
  const used = new Set(pads.map((pad) => pad.id));
  let index = 1;
  while (used.has(`pad-${index}`)) {
    index += 1;
  }
  return `pad-${index}`;
};

export const evaluatePadPlacement = (
  targetCourse: Course,
  pads: readonly BoostPad[],
  position: Vec2,
  id: string = nextPadId(pads),
): PadPlacement => {
  const nearest = nearestCoursePosition(targetCourse, position);
  if (
    nearest.distance >
    targetCourse.roadWidth / 2 + PAD_CORRIDOR_MARGIN_METERS
  ) {
    return {
      accepted: false,
      reason: "corridor",
      message: PAD_REJECTION_MESSAGES.corridor,
    };
  }
  for (const pad of pads) {
    if (
      Math.hypot(pad.x - position.x, pad.y - position.y) <
      PAD_MIN_SEPARATION_METERS
    ) {
      return {
        accepted: false,
        reason: "pad",
        message: PAD_REJECTION_MESSAGES.pad,
      };
    }
  }
  for (const gate of gatePositions(targetCourse)) {
    if (
      Math.hypot(gate.x - position.x, gate.y - position.y) <
      GATE_CLEARANCE_METERS
    ) {
      return {
        accepted: false,
        reason: "gate",
        message: PAD_REJECTION_MESSAGES.gate,
      };
    }
  }
  return {
    accepted: true,
    pad: {
      id,
      x: position.x,
      y: position.y,
      heading: Math.atan2(nearest.tangent.y, nearest.tangent.x),
    },
  };
};

export const padFootprint = (pad: BoostPad): readonly Vec2[] => {
  const along = { x: Math.cos(pad.heading), y: Math.sin(pad.heading) };
  const across = { x: -along.y, y: along.x };
  const half = PAD_LENGTH_METERS / 2;
  const side = PAD_WIDTH_METERS / 2;
  return [
    {
      x: pad.x - along.x * half - across.x * side,
      y: pad.y - along.y * half - across.y * side,
    },
    {
      x: pad.x + along.x * half - across.x * side,
      y: pad.y + along.y * half - across.y * side,
    },
    {
      x: pad.x + along.x * half + across.x * side,
      y: pad.y + along.y * half + across.y * side,
    },
    {
      x: pad.x - along.x * half + across.x * side,
      y: pad.y - along.y * half + across.y * side,
    },
  ];
};

export const padContains = (pad: BoostPad, position: Vec2): boolean => {
  const dx = position.x - pad.x;
  const dy = position.y - pad.y;
  const cos = Math.cos(pad.heading);
  const sin = Math.sin(pad.heading);
  return (
    Math.abs(dx * cos + dy * sin) <= PAD_LENGTH_METERS / 2 &&
    Math.abs(-dx * sin + dy * cos) <= PAD_WIDTH_METERS / 2
  );
};

export const padUnderPoint = (
  pads: readonly BoostPad[],
  position: Vec2,
): BoostPad | null =>
  pads.find((pad) => padContains(pad, position)) ?? null;

export const removePadAt = (
  pads: readonly BoostPad[],
  position: Vec2,
): Readonly<{ pads: readonly BoostPad[]; removed: BoostPad | null }> => {
  const removed = padUnderPoint(pads, position);
  if (!removed) {
    return { pads, removed: null };
  }
  return {
    pads: pads.filter((pad) => pad.id !== removed.id),
    removed,
  };
};

export const courseKey = (targetCourse: Course): string =>
  `${targetCourse.place}|${targetCourse.bboxLabel}`;

export type PadStorage = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}>;

export const serializePads = (
  targetCourse: Course,
  pads: readonly BoostPad[],
): string =>
  JSON.stringify({
    version: 1,
    courseKey: courseKey(targetCourse),
    pads,
  });

const isFinitePad = (value: unknown): value is BoostPad => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<BoostPad>;
  return (
    typeof candidate.id === "string" &&
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    Number.isFinite(candidate.heading)
  );
};

export const parsePads = (
  targetCourse: Course,
  text: string | null,
): readonly BoostPad[] => {
  if (!text) {
    return [];
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const stored = payload as {
    version?: unknown;
    courseKey?: unknown;
    pads?: unknown;
  };
  if (
    stored.version !== 1 ||
    stored.courseKey !== courseKey(targetCourse) ||
    !Array.isArray(stored.pads)
  ) {
    return [];
  }
  const accepted: BoostPad[] = [];
  for (const candidate of stored.pads) {
    if (!isFinitePad(candidate)) {
      continue;
    }
    const placement = evaluatePadPlacement(
      targetCourse,
      accepted,
      { x: candidate.x, y: candidate.y },
      candidate.id,
    );
    if (placement.accepted) {
      accepted.push(placement.pad);
    }
  }
  return accepted;
};

export const loadPads = (
  targetCourse: Course,
  storage: PadStorage,
): readonly BoostPad[] => {
  try {
    return parsePads(targetCourse, storage.getItem(BOOST_PADS_KEY));
  } catch {
    return [];
  }
};

export const savePads = (
  targetCourse: Course,
  pads: readonly BoostPad[],
  storage: PadStorage,
): void => {
  try {
    storage.setItem(BOOST_PADS_KEY, serializePads(targetCourse, pads));
  } catch {
    // Storage can be unavailable in private browsing; pads stay in memory.
  }
};
