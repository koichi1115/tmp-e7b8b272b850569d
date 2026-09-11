import type { Course, Vec2 } from "./course";
import type { Vehicle } from "./race";
import {
  isRoadPassable,
  type VehicleDefinition,
  type VehicleId,
} from "./vehicles";

export type MinimapRenderResult = Readonly<{
  arrowX: number;
  arrowY: number;
  arrowHeading: number;
  visible: true;
  orientation: "north-up";
}>;

const WIDTH = 190;
const HEIGHT = 150;
const MARGIN = 18;
const PADDING = 10;
const CACHE_SCALE = 2;

const backgrounds = new WeakMap<
  Course,
  Map<VehicleId, HTMLCanvasElement>
>();

const mapTransform = (course: Course) => {
  const scale = Math.min(
    (WIDTH - PADDING * 2) / course.width,
    (HEIGHT - PADDING * 2) / course.height,
  );
  return {
    scale,
    worldX: 0,
    worldY: 0,
    offsetX: (WIDTH - course.width * scale) / 2,
    offsetY: (HEIGHT - course.height * scale) / 2,
  };
};

const mapPoint = (
  point: Vec2,
  transform: ReturnType<typeof mapTransform>,
): Vec2 => ({
  x: transform.offsetX + (point.x - transform.worldX) * transform.scale,
  y: transform.offsetY + (point.y - transform.worldY) * transform.scale,
});

const traceLine = (
  context: CanvasRenderingContext2D,
  points: readonly Vec2[],
  transform: ReturnType<typeof mapTransform>,
): void => {
  points.forEach((point, index) => {
    const mapped = mapPoint(point, transform);
    if (index === 0) {
      context.moveTo(mapped.x, mapped.y);
    } else {
      context.lineTo(mapped.x, mapped.y);
    }
  });
};

const createBackground = (
  course: Course,
  selectedVehicle: VehicleDefinition,
): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * CACHE_SCALE;
  canvas.height = HEIGHT * CACHE_SCALE;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D rendering is unavailable.");
  }
  context.scale(CACHE_SCALE, CACHE_SCALE);
  context.fillStyle = "rgba(8, 17, 14, 0.9)";
  context.beginPath();
  context.roundRect(0.5, 0.5, WIDTH - 1, HEIGHT - 1, 12);
  context.fill();
  context.strokeStyle = "rgba(199, 215, 204, 0.3)";
  context.lineWidth = 1;
  context.stroke();

  const transform = mapTransform(course);
  context.save();
  context.beginPath();
  context.roundRect(1, 1, WIDTH - 2, HEIGHT - 2, 11);
  context.clip();
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const road of course.roads) {
    const passable = isRoadPassable(
      selectedVehicle.id,
      road.highway,
    );
    context.beginPath();
    traceLine(context, road.points, transform);
    context.strokeStyle = passable
      ? "rgba(136, 157, 145, 0.42)"
      : "rgba(212, 106, 93, 0.92)";
    context.lineWidth = passable ? 0.9 : 1.8;
    context.setLineDash(passable ? [] : [3, 2]);
    context.stroke();
  }
  context.setLineDash([]);
  context.beginPath();
  traceLine(context, course.lap, transform);
  context.strokeStyle = "rgba(95, 105, 95, 0.9)";
  context.lineWidth = 5.4;
  context.stroke();
  context.beginPath();
  traceLine(context, course.lap, transform);
  context.strokeStyle = "#f5c451";
  context.lineWidth = 2.2;
  context.stroke();
  context.restore();

  context.fillStyle = "rgba(231, 237, 232, 0.72)";
  context.font = "700 8px ui-monospace, monospace";
  context.textAlign = "center";
  context.fillText("北", WIDTH - 10, 12);
  return canvas;
};

const backgroundFor = (
  course: Course,
  selectedVehicle: VehicleDefinition,
): HTMLCanvasElement => {
  const byVehicle = backgrounds.get(course) ?? new Map();
  backgrounds.set(course, byVehicle);
  const cached = byVehicle.get(selectedVehicle.id);
  if (cached) {
    return cached;
  }
  const background = createBackground(course, selectedVehicle);
  byVehicle.set(selectedVehicle.id, background);
  return background;
};

export const drawMinimap = (
  context: CanvasRenderingContext2D,
  course: Course,
  vehicle: Vehicle,
  selectedVehicle: VehicleDefinition,
  viewportWidth: number,
  viewportHeight: number,
): MinimapRenderResult => {
  const originX = viewportWidth - WIDTH - MARGIN;
  const originY = viewportHeight - HEIGHT - MARGIN;
  const transform = mapTransform(course);
  const localArrow = mapPoint(vehicle.position, transform);
  const arrowX = originX + localArrow.x;
  const arrowY = originY + localArrow.y;

  context.save();
  context.drawImage(
    backgroundFor(course, selectedVehicle),
    originX,
    originY,
    WIDTH,
    HEIGHT,
  );
  context.beginPath();
  context.roundRect(originX + 1, originY + 1, WIDTH - 2, HEIGHT - 2, 11);
  context.clip();
  context.translate(arrowX, arrowY);
  context.rotate(vehicle.heading);
  context.beginPath();
  context.moveTo(8, 0);
  context.lineTo(-6, -4.5);
  context.lineTo(-3, 0);
  context.lineTo(-6, 4.5);
  context.closePath();
  context.fillStyle = selectedVehicle.color;
  context.fill();
  context.strokeStyle = "#fff1ba";
  context.lineWidth = 1.4;
  context.stroke();
  context.restore();

  return {
    arrowX,
    arrowY,
    arrowHeading: vehicle.heading,
    visible: true,
    orientation: "north-up",
  };
};
