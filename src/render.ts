import { padFootprint } from "./boost-pads.ts";
import {
  checkpointLabel,
  nextViaNumber,
  pointAtProgress,
  type Course,
  type Vec2,
} from "./course.ts";
import {
  drawMinimap,
  type MinimapRenderResult,
} from "./minimap.ts";
import {
  renderChaseView,
  type BuildView,
  type SceneOptions,
} from "./perspective.ts";
import type { RaceState } from "./race.ts";
import {
  isRoadPassable,
  type VehicleDefinition,
} from "./vehicles.ts";

export type ViewMode = "chase" | "topDown";
export type { BuildView, SceneOptions };

type Viewport = Readonly<{
  scale: number;
  offsetX: number;
  offsetY: number;
  worldX: number;
  worldY: number;
  width: number;
  height: number;
}>;

const resizeCanvas = (canvas: HTMLCanvasElement): Viewport => {
  const rectangle = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.round(rectangle.width * ratio));
  const pixelHeight = Math.max(1, Math.round(rectangle.height * ratio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D rendering is unavailable.");
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    worldX: 0,
    worldY: 0,
    width: rectangle.width,
    height: rectangle.height,
  };
};

const fitCourse = (
  course: Course,
  viewport: Viewport,
  showWholeFixture: boolean,
): Viewport => {
  const padding = Math.max(28, Math.min(viewport.width, viewport.height) * 0.07);
  const lapXs = course.lap.map((point) => point.x);
  const lapYs = course.lap.map((point) => point.y);
  const margin = 42;
  const worldX = showWholeFixture ? 0 : Math.min(...lapXs) - margin;
  const worldY = showWholeFixture ? 0 : Math.min(...lapYs) - margin;
  const worldWidth = showWholeFixture
    ? course.width
    : Math.max(...lapXs) - Math.min(...lapXs) + margin * 2;
  const worldHeight = showWholeFixture
    ? course.height
    : Math.max(...lapYs) - Math.min(...lapYs) + margin * 2;
  const scale = Math.min(
    (viewport.width - padding * 2) / worldWidth,
    (viewport.height - padding * 2) / worldHeight,
  );
  return {
    ...viewport,
    scale,
    offsetX: (viewport.width - worldWidth * scale) / 2,
    offsetY: (viewport.height - worldHeight * scale) / 2,
    worldX,
    worldY,
  };
};

const screenPoint = (point: Vec2, viewport: Viewport): Vec2 => ({
  x: viewport.offsetX + (point.x - viewport.worldX) * viewport.scale,
  y: viewport.offsetY + (point.y - viewport.worldY) * viewport.scale,
});

const traceLine = (
  context: CanvasRenderingContext2D,
  points: readonly Vec2[],
  viewport: Viewport,
): void => {
  points.forEach((point, index) => {
    const screen = screenPoint(point, viewport);
    if (index === 0) {
      context.moveTo(screen.x, screen.y);
    } else {
      context.lineTo(screen.x, screen.y);
    }
  });
};

const drawTopDownLandscape = (
  context: CanvasRenderingContext2D,
  course: Course,
  viewport: Viewport,
): void => {
  const landColors = {
    park: "#456d50",
    grass: "#58754e",
    wood: "#314f3b",
    water: "#315d66",
  } as const;
  for (const area of course.landAreas) {
    context.beginPath();
    traceLine(context, area.points, viewport);
    context.closePath();
    context.fillStyle = landColors[area.category];
    context.fill();
  }
  for (const building of course.buildings) {
    context.beginPath();
    traceLine(context, building.footprint, viewport);
    context.closePath();
    context.fillStyle = "#746f63";
    context.fill();
    context.strokeStyle = "#918979";
    context.lineWidth = Math.max(0.5, viewport.scale * 0.35);
    context.stroke();
  }
};

const drawBlockedRoads = (
  context: CanvasRenderingContext2D,
  course: Course,
  viewport: Viewport,
  selectedVehicle: VehicleDefinition,
): void => {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const road of course.roads) {
    if (isRoadPassable(selectedVehicle.id, road.highway)) {
      continue;
    }
    context.beginPath();
    traceLine(context, road.points, viewport);
    context.strokeStyle = "rgba(107, 52, 48, 0.75)";
    context.lineWidth = course.roadWidth * viewport.scale;
    context.stroke();
    context.beginPath();
    traceLine(context, road.points, viewport);
    context.setLineDash([5, 5]);
    context.strokeStyle = "#d46a5d";
    context.lineWidth = Math.max(1.5, viewport.scale);
    context.stroke();
    context.setLineDash([]);
  }
  context.restore();
};

const drawCourse = (
  context: CanvasRenderingContext2D,
  course: Course,
  viewport: Viewport,
  progress: number,
): void => {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  context.beginPath();
  traceLine(context, course.lap, viewport);
  context.strokeStyle = "#5f695f";
  context.lineWidth = course.roadWidth * viewport.scale + 5;
  context.stroke();

  context.beginPath();
  traceLine(context, course.lap, viewport);
  context.strokeStyle = "#26332f";
  context.lineWidth = course.roadWidth * viewport.scale;
  context.stroke();

  context.beginPath();
  traceLine(context, course.lap, viewport);
  context.strokeStyle = "rgba(241, 236, 204, 0.5)";
  context.setLineDash([8, 10]);
  context.lineWidth = Math.max(1, viewport.scale);
  context.stroke();
  context.setLineDash([]);

  if (progress > 0.015) {
    const targetDistance = Math.min(progress, 1) * course.lapLength;
    context.beginPath();
    const first = screenPoint(course.lap[0] ?? { x: 0, y: 0 }, viewport);
    context.moveTo(first.x, first.y);
    for (let index = 1; index < course.lap.length; index += 1) {
      const segmentEnd = course.lapCumulative[index];
      const point = course.lap[index];
      if (segmentEnd === undefined || point === undefined) {
        continue;
      }
      if (segmentEnd <= targetDistance) {
        const screen = screenPoint(point, viewport);
        context.lineTo(screen.x, screen.y);
        continue;
      }
      const target = pointAtProgress(course, progress);
      const screen = screenPoint(target.point, viewport);
      context.lineTo(screen.x, screen.y);
      break;
    }
    context.strokeStyle = "#f5c451";
    context.lineWidth = Math.max(2, 1.9 * viewport.scale);
    context.stroke();
  }
  context.restore();
};

const drawDebugRoads = (
  context: CanvasRenderingContext2D,
  course: Course,
  viewport: Viewport,
): void => {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(93, 208, 211, 0.75)";
  context.lineWidth = Math.max(1, viewport.scale * 0.9);
  for (const road of course.roads) {
    context.beginPath();
    traceLine(context, road.points, viewport);
    context.stroke();
  }

  context.strokeStyle = "rgba(93, 208, 211, 0.42)";
  context.lineWidth = 1;
  context.setLineDash([4, 5]);
  const corner = screenPoint({ x: 0, y: 0 }, viewport);
  context.strokeRect(
    corner.x,
    corner.y,
    course.width * viewport.scale,
    course.height * viewport.scale,
  );
  context.restore();
};

const drawStartLine = (
  context: CanvasRenderingContext2D,
  course: Course,
  viewport: Viewport,
): void => {
  const start = pointAtProgress(course, 0);
  const center = screenPoint(start.point, viewport);
  const normal = { x: -start.tangent.y, y: start.tangent.x };
  const width = course.roadWidth * viewport.scale;
  const blocks = 8;
  context.save();
  context.lineCap = "butt";
  context.lineWidth = Math.max(3, width / blocks);
  for (let index = 0; index < blocks; index += 1) {
    const amount = (index + 0.5) / blocks - 0.5;
    context.beginPath();
    context.moveTo(
      center.x + normal.x * width * amount,
      center.y + normal.y * width * amount,
    );
    context.lineTo(
      center.x + normal.x * width * (amount + 1 / blocks),
      center.y + normal.y * width * (amount + 1 / blocks),
    );
    context.strokeStyle = index % 2 === 0 ? "#f8f2d8" : "#e35b45";
    context.stroke();
  }
  context.restore();
};

const drawCheckpoints = (
  context: CanvasRenderingContext2D,
  course: Course,
  viewport: Viewport,
  passed: number,
): void => {
  course.checkpointFractions.forEach((fraction, index) => {
    const checkpoint = pointAtProgress(course, fraction);
    const point = screenPoint(checkpoint.point, viewport);
    const radius = Math.max(5, 4.5 * viewport.scale);
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle = index < passed ? "#f5c451" : "#15231e";
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = index < passed ? "#fff1ba" : "#91a59b";
    context.stroke();
    context.fillStyle = index < passed ? "#17231f" : "#dbe6df";
    context.font = `700 ${Math.max(9, radius * 1.1)}px ui-monospace, monospace`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      checkpointLabel(course, index),
      point.x,
      point.y + 0.5,
    );
  });
};

const drawPads = (
  context: CanvasRenderingContext2D,
  viewport: Viewport,
  scene: SceneOptions,
): void => {
  context.save();
  for (const pad of scene.pads) {
    context.beginPath();
    traceLine(context, padFootprint(pad), viewport);
    context.closePath();
    context.fillStyle =
      pad.id === scene.boostPadId ? "#7de3f3" : "#2fa8c9";
    context.fill();
    context.strokeStyle = "#eafaff";
    context.lineWidth = Math.max(1, viewport.scale * 0.3);
    context.stroke();
  }
  if (scene.build) {
    const walker = screenPoint(scene.build.walker.position, viewport);
    context.beginPath();
    context.arc(
      walker.x,
      walker.y,
      Math.max(4, viewport.scale * 1.6),
      0,
      Math.PI * 2,
    );
    context.fillStyle = scene.build.placementValid
      ? "rgba(100, 194, 139, 0.85)"
      : "rgba(227, 91, 69, 0.85)";
    context.fill();
    context.strokeStyle = "#f7fbf8";
    context.lineWidth = 1.5;
    context.stroke();
  }
  context.restore();
};

const drawVehicle = (
  context: CanvasRenderingContext2D,
  state: RaceState,
  viewport: Viewport,
  selectedVehicle: VehicleDefinition,
): void => {
  const vehicle = screenPoint(state.vehicle.position, viewport);
  const length = Math.max(14, 8 * viewport.scale);
  const width = Math.max(8, 4.4 * viewport.scale);
  context.save();
  context.translate(vehicle.x, vehicle.y);
  context.rotate(state.vehicle.heading);
  context.shadowColor = state.onRoad
    ? "rgba(0, 0, 0, 0.45)"
    : "rgba(227, 91, 69, 0.8)";
  context.shadowBlur = state.onRoad ? 7 : 15;
  context.shadowOffsetY = 3;
  context.fillStyle = selectedVehicle.color;
  context.beginPath();
  context.roundRect(-length / 2, -width / 2, length, width, width * 0.28);
  context.fill();
  context.shadowColor = "transparent";
  context.fillStyle = "#f7d9a3";
  context.fillRect(-length * 0.06, -width * 0.37, length * 0.28, width * 0.74);
  context.fillStyle = "#13221d";
  context.fillRect(length * 0.34, -width * 0.2, length * 0.11, width * 0.4);
  context.restore();
};

const drawNorthArrow = (
  context: CanvasRenderingContext2D,
  viewport: Viewport,
): void => {
  context.save();
  context.translate(viewport.width - 28, 30);
  context.fillStyle = "rgba(222, 235, 225, 0.72)";
  context.font = "700 10px ui-monospace, monospace";
  context.textAlign = "center";
  context.fillText("北", 0, -9);
  context.beginPath();
  context.moveTo(0, -5);
  context.lineTo(-4, 7);
  context.lineTo(0, 4);
  context.lineTo(4, 7);
  context.closePath();
  context.fill();
  context.restore();
};

export const renderRace = (
  canvas: HTMLCanvasElement,
  course: Course,
  state: RaceState,
  debug: boolean,
  viewMode: ViewMode,
  selectedVehicle: VehicleDefinition,
  scene: SceneOptions = { pads: [], boostPadId: null, build: null },
): MinimapRenderResult => {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D rendering is unavailable.");
  }
  const viewport = fitCourse(course, resizeCanvas(canvas), debug);
  context.clearRect(0, 0, viewport.width, viewport.height);
  if (viewMode === "chase") {
    renderChaseView(
      context,
      course,
      state,
      debug,
      selectedVehicle,
      viewport.width,
      viewport.height,
      scene,
    );
  } else {
    context.fillStyle = "#14211c";
    context.fillRect(0, 0, viewport.width, viewport.height);

    const gradient = context.createRadialGradient(
      viewport.width * 0.42,
      viewport.height * 0.48,
      0,
      viewport.width * 0.42,
      viewport.height * 0.48,
      Math.max(viewport.width, viewport.height) * 0.7,
    );
    gradient.addColorStop(0, "rgba(71, 95, 77, 0.2)");
    gradient.addColorStop(1, "rgba(4, 10, 8, 0.28)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, viewport.width, viewport.height);

    drawTopDownLandscape(context, course, viewport);
    drawBlockedRoads(context, course, viewport, selectedVehicle);
    if (debug) {
      drawDebugRoads(context, course, viewport);
    }
    drawCourse(context, course, viewport, state.progress);
    drawCheckpoints(context, course, viewport, state.checkpointsPassed);
    drawStartLine(context, course, viewport);
    drawPads(context, viewport, scene);
    drawVehicle(context, state, viewport, selectedVehicle);
    drawNorthArrow(context, viewport);
  }
  return drawMinimap(
    context,
    course,
    state.vehicle,
    selectedVehicle,
    viewport.width,
    viewport.height,
    {
      ...scene,
      nextViaNumber: nextViaNumber(course, state.checkpointsPassed),
    },
  );
};
