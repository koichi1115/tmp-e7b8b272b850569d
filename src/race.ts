import {
  BOOST_ACCELERATION,
  BOOST_DURATION_MS,
  clampBoostedSpeed,
  padUnderPoint,
  type BoostPad,
} from "./boost-pads.ts";
import {
  nearestCoursePosition,
  nearestRoadPosition,
  pointAtProgress,
  type Course,
  type Vec2,
} from "./course.ts";
import {
  clampVehicleSpeed,
  isRoadPassable,
  type VehicleId,
} from "./vehicles.ts";

export type DriveInput = Readonly<{
  accelerate: boolean;
  brake: boolean;
  left: boolean;
  right: boolean;
}>;

export type Vehicle = Readonly<{
  position: Vec2;
  heading: number;
  speed: number;
}>;

type ReadyRace = Readonly<{
  kind: "ready";
  vehicle: Vehicle;
  elapsedMs: 0;
  progress: number;
  checkpointsPassed: 0;
  onRoad: true;
  blockedForMs: 0;
  blockedHits: 0;
  blockedHighway: null;
  boostRemainingMs: 0;
  boostPadId: null;
  boostHits: 0;
}>;

type RunningRace = Readonly<{
  kind: "running";
  vehicle: Vehicle;
  elapsedMs: number;
  progress: number;
  checkpointsPassed: number;
  onRoad: boolean;
  blockedForMs: number;
  blockedHits: number;
  blockedHighway: string | null;
  boostRemainingMs: number;
  boostPadId: string | null;
  boostHits: number;
}>;

type FinishedRace = Readonly<{
  kind: "finished";
  vehicle: Vehicle;
  elapsedMs: number;
  progress: 1;
  checkpointsPassed: number;
  onRoad: boolean;
  blockedForMs: number;
  blockedHits: number;
  blockedHighway: string | null;
  boostRemainingMs: number;
  boostPadId: string | null;
  boostHits: number;
}>;

export type RaceState = ReadyRace | RunningRace | FinishedRace;

const START_PROGRESS = 0.012;
const MAX_REVERSE_SPEED = -6;
const MAX_OFFROAD_SPEED = 7;
const BLOCKED_BOUNCE_SPEED = 1.5;
const BLOCKED_SPEED_RETENTION = 0.35;
const BLOCKED_NOTICE_MS = 650;
const STEERING_ASSIST_RATE = 0.35;
const STEERING_ASSIST_LIMIT = 0.7;
const LOOKAHEAD_BASE_METERS = 4;
const LOOKAHEAD_SECONDS = 0.35;
const LOOKAHEAD_MAX_METERS = 10;
const MIN_STEERING_RATE = 0.75;

export const createRace = (targetCourse: Course): RaceState => {
  const start = pointAtProgress(targetCourse, START_PROGRESS);
  return {
    kind: "ready",
    vehicle: {
      position: start.point,
      heading: Math.atan2(start.tangent.y, start.tangent.x),
      speed: 0,
    },
    elapsedMs: 0,
    progress: START_PROGRESS,
    checkpointsPassed: 0,
    onRoad: true,
    blockedForMs: 0,
    blockedHits: 0,
    blockedHighway: null,
    boostRemainingMs: 0,
    boostPadId: null,
    boostHits: 0,
  };
};

const moveVehicle = (
  vehicle: Vehicle,
  input: DriveInput,
  deltaSeconds: number,
  onRoad: boolean,
  vehicleId: VehicleId,
  boosting: boolean,
): Vehicle => {
  let speed = vehicle.speed;
  const traction = onRoad ? 1 : 0.32;

  if (input.accelerate) {
    speed += 15 * traction * deltaSeconds;
  }
  if (boosting && speed > 0) {
    speed += BOOST_ACCELERATION * traction * deltaSeconds;
  }
  if (input.brake) {
    speed += (speed > 0 ? -23 : -9 * traction) * deltaSeconds;
  }

  const rollingResistance = onRoad ? 1.25 : 7.5;
  if (!input.accelerate && !input.brake) {
    const resistance = Math.min(
      Math.abs(speed),
      rollingResistance * deltaSeconds,
    );
    speed -= Math.sign(speed) * resistance;
  }
  speed -=
    Math.sign(speed) * Math.min(Math.abs(speed), speed * speed * 0.012 * deltaSeconds);

  speed = boosting
    ? clampBoostedSpeed(speed, vehicleId, MAX_REVERSE_SPEED)
    : clampVehicleSpeed(speed, vehicleId, MAX_REVERSE_SPEED);
  if (!onRoad) {
    speed = Math.min(MAX_OFFROAD_SPEED, speed);
  }

  const steering = Number(input.right) - Number(input.left);
  let driveDirection = Math.sign(speed);
  if (Math.abs(speed) <= 0.05) {
    driveDirection = Number(input.accelerate) - Number(input.brake);
  }
  const steeringRate =
    steering === 0 || driveDirection === 0
      ? 0
      : Math.max(MIN_STEERING_RATE, Math.min(1, Math.abs(speed) / 7) * 1.7);
  const heading =
    vehicle.heading +
    steering * steeringRate * driveDirection * deltaSeconds;

  return {
    position: {
      x: vehicle.position.x + Math.cos(heading) * speed * deltaSeconds,
      y: vehicle.position.y + Math.sin(heading) * speed * deltaSeconds,
    },
    heading,
    speed,
  };
};

const roadAccessAt = (
  targetCourse: Course,
  position: Vec2,
  vehicleId: VehicleId,
) => ({
  passable: nearestRoadPosition(
    targetCourse,
    position,
    (road) => isRoadPassable(vehicleId, road.highway),
  ),
  blocked: nearestRoadPosition(
    targetCourse,
    position,
    (road) => !isRoadPassable(vehicleId, road.highway),
  ),
});

export const stepRace = (
  state: RaceState,
  input: DriveInput,
  deltaSeconds: number,
  targetCourse: Course,
  vehicleId: VehicleId,
  pads: readonly BoostPad[] = [],
): RaceState => {
  if (state.kind === "finished") {
    return state;
  }
  if (
    state.kind === "ready" &&
    !input.accelerate &&
    !input.brake
  ) {
    return state;
  }

  const stepSeconds = Math.min(deltaSeconds, 0.05);
  const currentCoursePosition = nearestCoursePosition(
    targetCourse,
    state.vehicle.position,
  );
  const currentRoadAccess = roadAccessAt(
    targetCourse,
    state.vehicle.position,
    vehicleId,
  );
  const wasOnRoad =
    (currentRoadAccess.passable?.distance ?? Number.POSITIVE_INFINITY) <=
    targetCourse.roadWidth / 2;
  let vehicleBeforeMove = state.vehicle;
  if (
    currentCoursePosition.distance <= targetCourse.roadWidth / 2 &&
    state.vehicle.speed > 1
  ) {
    const lookaheadMeters = Math.min(
      LOOKAHEAD_MAX_METERS,
      LOOKAHEAD_BASE_METERS + state.vehicle.speed * LOOKAHEAD_SECONDS,
    );
    const target = pointAtProgress(
      targetCourse,
      currentCoursePosition.progress +
        lookaheadMeters / targetCourse.lapLength,
    );
    const targetHeading = Math.atan2(
      target.point.y - state.vehicle.position.y,
      target.point.x - state.vehicle.position.x,
    );
    const headingError = Math.atan2(
      Math.sin(targetHeading - state.vehicle.heading),
      Math.cos(targetHeading - state.vehicle.heading),
    );
    if (Math.abs(headingError) <= STEERING_ASSIST_LIMIT) {
      const maximumAssist = STEERING_ASSIST_RATE * stepSeconds;
      vehicleBeforeMove = {
        ...state.vehicle,
        heading:
          state.vehicle.heading +
          Math.max(-maximumAssist, Math.min(maximumAssist, headingError)),
      };
    }
  }
  const decayedBoostMs = Math.max(
    0,
    (state.kind === "ready" ? 0 : state.boostRemainingMs) -
      deltaSeconds * 1_000,
  );
  let vehicle = moveVehicle(
    vehicleBeforeMove,
    input,
    stepSeconds,
    wasOnRoad,
    vehicleId,
    decayedBoostMs > 0,
  );
  const proposedRoadAccess = roadAccessAt(
    targetCourse,
    vehicle.position,
    vehicleId,
  );
  const blockedRoad =
    (proposedRoadAccess.blocked?.distance ?? Number.POSITIVE_INFINITY) <=
      targetCourse.roadWidth / 2 &&
    (proposedRoadAccess.passable?.distance ?? Number.POSITIVE_INFINITY) >
      targetCourse.roadWidth / 2;
  if (blockedRoad) {
    const direction = Math.sign(vehicle.speed) || 1;
    vehicle = {
      position: state.vehicle.position,
      heading: vehicle.heading,
      speed:
        -direction *
        Math.max(
          BLOCKED_BOUNCE_SPEED,
          Math.abs(vehicle.speed) * BLOCKED_SPEED_RETENTION,
        ),
    };
  }
  const coursePosition = nearestCoursePosition(
    targetCourse,
    vehicle.position,
  );
  const finalRoadAccess = roadAccessAt(
    targetCourse,
    vehicle.position,
    vehicleId,
  );
  const onRoad =
    (finalRoadAccess.passable?.distance ?? Number.POSITIVE_INFINITY) <=
    targetCourse.roadWidth / 2;
  const previousBlockedForMs =
    state.kind === "ready" ? 0 : state.blockedForMs;
  const blockedForMs = blockedRoad
    ? BLOCKED_NOTICE_MS
    : Math.max(0, previousBlockedForMs - deltaSeconds * 1_000);
  const blockedHits =
    (state.kind === "ready" ? 0 : state.blockedHits) +
    Number(blockedRoad);
  const previousBlockedHighway =
    state.kind === "ready" ? null : state.blockedHighway;
  const blockedHighway = blockedRoad
    ? (proposedRoadAccess.blocked?.road.highway ?? null)
    : blockedForMs > 0
      ? previousBlockedHighway
      : null;
  const elapsedMs =
    (state.kind === "ready" ? 0 : state.elapsedMs) + deltaSeconds * 1_000;

  const previousPadId = state.kind === "ready" ? null : state.boostPadId;
  const padUnderVehicle = padUnderPoint(pads, vehicle.position);
  const enteredPad =
    padUnderVehicle !== null &&
    (padUnderVehicle.id !== previousPadId || decayedBoostMs <= 0);
  const boostRemainingMs =
    padUnderVehicle === null ? decayedBoostMs : BOOST_DURATION_MS;
  const boostPadId =
    boostRemainingMs > 0
      ? (padUnderVehicle?.id ?? previousPadId)
      : null;
  const boostHits =
    (state.kind === "ready" ? 0 : state.boostHits) + Number(enteredPad);

  let checkpointsPassed =
    state.kind === "ready" ? 0 : state.checkpointsPassed;
  const nextCheckpoint =
    targetCourse.checkpointFractions[checkpointsPassed];
  if (
    nextCheckpoint !== undefined &&
    state.progress < nextCheckpoint &&
    coursePosition.progress >= nextCheckpoint &&
    coursePosition.progress - state.progress < 0.22
  ) {
    checkpointsPassed += 1;
  }

  const completedLap =
    checkpointsPassed === targetCourse.checkpointFractions.length &&
    state.progress > 0.82 &&
    coursePosition.progress < 0.12 &&
    vehicle.speed > 0.5 &&
    elapsedMs > 8_000;
  if (completedLap) {
    return {
      kind: "finished",
      vehicle,
      elapsedMs,
      progress: 1,
      checkpointsPassed,
      onRoad,
      blockedForMs,
      blockedHits,
      blockedHighway,
      boostRemainingMs,
      boostPadId,
      boostHits,
    };
  }

  return {
    kind: "running",
    vehicle,
    elapsedMs,
    progress: coursePosition.progress,
    checkpointsPassed,
    onRoad,
    blockedForMs,
    blockedHits,
    blockedHighway,
    boostRemainingMs,
    boostPadId,
    boostHits,
  };
};

export const formatTime = (milliseconds: number): string => {
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const hundredths = Math.floor((milliseconds % 1_000) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
};