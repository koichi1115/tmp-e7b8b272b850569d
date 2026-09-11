import {
  nearestCoursePosition,
  pointAtProgress,
} from "../src/course.ts";
import { createRace, stepRace } from "../src/race.ts";

const STEP_SECONDS = 1 / 60;
const LOOKAHEAD_METERS = 16;
const COAST_HEADING_ERROR = 1.05;
const STEER_HEADING_ERROR = 0.05;

const steerInput = (course, state) => {
  const nearest = nearestCoursePosition(course, state.vehicle.position);
  const target = pointAtProgress(
    course,
    nearest.progress + LOOKAHEAD_METERS / course.lapLength,
  );
  const targetHeading = Math.atan2(
    target.point.y - state.vehicle.position.y,
    target.point.x - state.vehicle.position.x,
  );
  const headingError = Math.atan2(
    Math.sin(targetHeading - state.vehicle.heading),
    Math.cos(targetHeading - state.vehicle.heading),
  );
  return {
    accelerate: Math.abs(headingError) <= COAST_HEADING_ERROR,
    brake: false,
    left: headingError < -STEER_HEADING_ERROR,
    right: headingError > STEER_HEADING_ERROR,
  };
};

/**
 * Drives one deterministic lap with a fixed timestep centreline follower.
 * The same inputs always produce the same lap, so two runs differ only by
 * the boost pads handed in.
 */
export const driveLap = (
  course,
  vehicleId,
  pads = [],
  { maxSeconds = 240, sample = false } = {},
) => {
  let state = createRace(course);
  let peakSpeed = 0;
  let peakBoostedSpeed = 0;
  const samples = [];
  const steps = Math.round(maxSeconds / STEP_SECONDS);
  for (let step = 0; step < steps; step += 1) {
    state = stepRace(
      state,
      steerInput(course, state),
      STEP_SECONDS,
      course,
      vehicleId,
      pads,
    );
    peakSpeed = Math.max(peakSpeed, state.vehicle.speed);
    if (state.boostRemainingMs > 0) {
      peakBoostedSpeed = Math.max(peakBoostedSpeed, state.vehicle.speed);
    }
    if (sample) {
      samples.push({
        elapsedMs: state.elapsedMs,
        speed: state.vehicle.speed,
        boostRemainingMs: state.boostRemainingMs,
        boostPadId: state.boostPadId,
      });
    }
    if (state.kind === "finished") {
      break;
    }
  }
  return {
    finished: state.kind === "finished",
    lapMs: state.elapsedMs,
    checkpointsPassed: state.checkpointsPassed,
    peakSpeed,
    peakBoostedSpeed,
    boostHits: state.boostHits,
    state,
    samples,
  };
};

export { STEP_SECONDS };
