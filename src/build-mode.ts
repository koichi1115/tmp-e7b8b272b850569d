import type { Course, Vec2 } from "./course.ts";
import type { DriveInput } from "./race.ts";

export const WALK_SPEED_MPS = 2.4;
export const WALK_TURN_RATE = 1.9;

export type Walker = Readonly<{
  position: Vec2;
  heading: number;
}>;

const clampToFixture = (
  targetCourse: Course,
  position: Vec2,
): Vec2 => ({
  x: Math.max(0, Math.min(targetCourse.width, position.x)),
  y: Math.max(0, Math.min(targetCourse.height, position.y)),
});

export const stepWalker = (
  walker: Walker,
  input: DriveInput,
  deltaSeconds: number,
  targetCourse: Course,
): Walker => {
  const stepSeconds = Math.min(deltaSeconds, 0.05);
  const turn = Number(input.right) - Number(input.left);
  const heading = walker.heading + turn * WALK_TURN_RATE * stepSeconds;
  const forward = Number(input.accelerate) - Number(input.brake);
  const distance = forward * WALK_SPEED_MPS * stepSeconds;
  return {
    position: clampToFixture(targetCourse, {
      x: walker.position.x + Math.cos(heading) * distance,
      y: walker.position.y + Math.sin(heading) * distance,
    }),
    heading,
  };
};
