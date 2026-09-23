import type { BoostPad } from "./boost-pads.ts";
import type { Walker } from "./build-mode.ts";
import type { Course, Vec2 } from "./course.ts";
import type { Vehicle } from "./race.ts";
import {
  isRoadPassable,
  type VehicleDefinition,
  type VehicleId,
} from "./vehicles.ts";

export type MinimapOverlay = Readonly<{
  pads: readonly BoostPad[];
  boostPadId: string | null;
  build: Readonly<{ walker: Walker }> | null;
  /** 次に目指す経由点の番号（1始まり）。経由コースでない時は null。 */
  nextViaNumber?: number | null;
}>;

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
  overlay: MinimapOverlay = {
    pads: [],
    boostPadId: null,
    build: null,
    nextViaNumber: null,
  },
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
  for (const pad of overlay.pads) {
    const mapped = mapPoint({ x: pad.x, y: pad.y }, transform);
    context.beginPath();
    context.arc(
      originX + mapped.x,
      originY + mapped.y,
      pad.id === overlay.boostPadId ? 3.4 : 2.4,
      0,
      Math.PI * 2,
    );
    context.fillStyle =
      pad.id === overlay.boostPadId ? "#9beefb" : "#2fa8c9";
    context.fill();
  }
  // 経由コースでは、通る順の番号を走行中の地図にも出します。
  course.viaPoints.forEach((via, index) => {
    const mapped = mapPoint(via, transform);
    const next = overlay.nextViaNumber === index + 1;
    context.beginPath();
    context.arc(
      originX + mapped.x,
      originY + mapped.y,
      next ? 7 : 5.6,
      0,
      Math.PI * 2,
    );
    context.fillStyle = next ? "#f5c451" : "#16241f";
    context.fill();
    context.strokeStyle = next ? "#fff1ba" : "#b7c8bd";
    context.lineWidth = 1.4;
    context.stroke();
    context.fillStyle = next ? "#17231f" : "#e7ede8";
    context.font = "700 8px ui-monospace, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      String(index + 1),
      originX + mapped.x,
      originY + mapped.y + 0.5,
    );
  });
  if (overlay.build) {
    const mapped = mapPoint(overlay.build.walker.position, transform);
    context.beginPath();
    context.arc(originX + mapped.x, originY + mapped.y, 2.6, 0, Math.PI * 2);
    context.fillStyle = "#64c28b";
    context.fill();
  }
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
