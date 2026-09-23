import {
  PAD_LENGTH_METERS,
  PAD_WIDTH_METERS,
  padFootprint,
  type BoostPad,
} from "./boost-pads.ts";
import type { Walker } from "./build-mode.ts";
import {
  checkpointLabel,
  pointAtProgress,
  type Course,
  type Vec2,
} from "./course.ts";
import type { RaceState } from "./race.ts";
import {
  isRoadPassable,
  type VehicleDefinition,
} from "./vehicles.ts";

export type BuildView = Readonly<{
  walker: Walker;
  placementValid: boolean;
}>;

export type SceneOptions = Readonly<{
  pads: readonly BoostPad[];
  boostPadId: string | null;
  build: BuildView | null;
}>;

type EyeView = Readonly<{
  kind: "race" | "build";
  position: Vec2;
  heading: number;
}>;

export const sceneEye = (
  state: RaceState,
  scene: SceneOptions,
): EyeView =>
  scene.build
    ? {
        kind: "build",
        position: scene.build.walker.position,
        heading: scene.build.walker.heading,
      }
    : {
        kind: "race",
        position: state.vehicle.position,
        heading: state.vehicle.heading,
      };

type Vec3 = Readonly<{ x: number; y: number; z: number }>;
type CameraPoint = Readonly<{ right: number; up: number; depth: number }>;
type ScreenPoint = Readonly<{ x: number; y: number; depth: number }>;
type Camera = Readonly<{
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  focalLength: number;
  centerX: number;
  centerY: number;
  near: number;
}>;
type PolygonCommand = Readonly<{
  id: string;
  points: readonly ScreenPoint[];
  depth: number;
  fill: string;
  stroke?: string;
}>;

const LAND_COLORS = {
  park: "#456d50",
  grass: "#58754e",
  wood: "#314f3b",
  water: "#315d66",
} as const;

const normalize3 = (vector: Vec3): Vec3 => {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
};

const CAMERA_RIGS = {
  race: { back: 20, eye: 12, ahead: 27, aim: 0.8 },
  build: { back: 8, eye: 3.4, ahead: 16, aim: 0.6 },
} as const;

const makeCamera = (
  view: EyeView,
  width: number,
  height: number,
): Camera => {
  const rig = CAMERA_RIGS[view.kind];
  const heading = view.heading;
  const direction = { x: Math.cos(heading), y: Math.sin(heading) };
  const position = {
    x: view.position.x - direction.x * rig.back,
    y: view.position.y - direction.y * rig.back,
    z: rig.eye,
  };
  const target = {
    x: view.position.x + direction.x * rig.ahead,
    y: view.position.y + direction.y * rig.ahead,
    z: rig.aim,
  };
  const forward = normalize3({
    x: target.x - position.x,
    y: target.y - position.y,
    z: target.z - position.z,
  });
  const horizontalLength = Math.hypot(forward.x, forward.y);
  const right = {
    x: -forward.y / horizontalLength,
    y: forward.x / horizontalLength,
    z: 0,
  };
  const up = {
    x: (-forward.x * forward.z) / horizontalLength,
    y: (-forward.y * forward.z) / horizontalLength,
    z: horizontalLength,
  };
  return {
    position,
    forward,
    right,
    up,
    focalLength: Math.min(width, height) * 0.92,
    centerX: width / 2,
    centerY: height * 0.4,
    near: 1.5,
  };
};

const cameraPoint = (camera: Camera, point: Vec3): CameraPoint => {
  const relative = {
    x: point.x - camera.position.x,
    y: point.y - camera.position.y,
    z: point.z - camera.position.z,
  };
  return {
    right:
      relative.x * camera.right.x +
      relative.y * camera.right.y +
      relative.z * camera.right.z,
    up:
      relative.x * camera.up.x +
      relative.y * camera.up.y +
      relative.z * camera.up.z,
    depth:
      relative.x * camera.forward.x +
      relative.y * camera.forward.y +
      relative.z * camera.forward.z,
  };
};

const clipNear = (
  points: readonly CameraPoint[],
  near: number,
): CameraPoint[] => {
  const clipped: CameraPoint[] = [];
  let previous = points.at(-1);
  if (!previous) {
    return clipped;
  }
  for (const point of points) {
    const pointInside = point.depth >= near;
    const previousInside = previous.depth >= near;
    if (pointInside !== previousInside) {
      const amount = (near - previous.depth) / (point.depth - previous.depth);
      clipped.push({
        right: previous.right + (point.right - previous.right) * amount,
        up: previous.up + (point.up - previous.up) * amount,
        depth: near,
      });
    }
    if (pointInside) {
      clipped.push(point);
    }
    previous = point;
  }
  return clipped;
};

const projectPolygon = (
  camera: Camera,
  points: readonly Vec3[],
): readonly ScreenPoint[] => {
  const clipped = clipNear(
    points.map((point) => cameraPoint(camera, point)),
    camera.near,
  );
  return clipped.map((point) => ({
    x: camera.centerX + (point.right / point.depth) * camera.focalLength,
    y: camera.centerY - (point.up / point.depth) * camera.focalLength,
    depth: point.depth,
  }));
};

const projectPoint = (
  camera: Camera,
  point: Vec3,
): ScreenPoint | null => {
  const projected = cameraPoint(camera, point);
  if (projected.depth < camera.near) {
    return null;
  }
  return {
    x: camera.centerX + (projected.right / projected.depth) * camera.focalLength,
    y: camera.centerY - (projected.up / projected.depth) * camera.focalLength,
    depth: projected.depth,
  };
};

const polygonCommand = (
  camera: Camera,
  id: string,
  points: readonly Vec3[],
  fill: string,
  stroke?: string,
): PolygonCommand | null => {
  const projected = projectPolygon(camera, points);
  if (projected.length < 3) {
    return null;
  }
  return {
    id,
    points: projected,
    depth:
      projected.reduce((total, point) => total + point.depth, 0) /
      projected.length,
    fill,
    stroke,
  };
};

const drawPolygon = (
  context: CanvasRenderingContext2D,
  command: PolygonCommand,
): void => {
  const first = command.points[0];
  if (!first) {
    return;
  }
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (let index = 1; index < command.points.length; index += 1) {
    const point = command.points[index];
    if (point) {
      context.lineTo(point.x, point.y);
    }
  }
  context.closePath();
  context.fillStyle = command.fill;
  context.fill();
  if (command.stroke) {
    context.strokeStyle = command.stroke;
    context.lineWidth = 1;
    context.stroke();
  }
};

const drawSorted = (
  context: CanvasRenderingContext2D,
  commands: readonly PolygonCommand[],
): void => {
  [...commands]
    .sort(
      (left, right) =>
        right.depth - left.depth ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
    .forEach((command) => drawPolygon(context, command));
};

const segmentQuad = (
  first: Vec2,
  second: Vec2,
  width: number,
  z: number,
): readonly Vec3[] => {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const length = Math.hypot(dx, dy);
  const normal = { x: (-dy / length) * width / 2, y: (dx / length) * width / 2 };
  return [
    { x: first.x + normal.x, y: first.y + normal.y, z },
    { x: second.x + normal.x, y: second.y + normal.y, z },
    { x: second.x - normal.x, y: second.y - normal.y, z },
    { x: first.x - normal.x, y: first.y - normal.y, z },
  ];
};

const pushLineCommands = (
  commands: PolygonCommand[],
  camera: Camera,
  id: string,
  points: readonly Vec2[],
  width: number,
  z: number,
  fill: string,
): void => {
  for (let index = 1; index < points.length; index += 1) {
    const first = points[index - 1];
    const second = points[index];
    if (!first || !second || first.x === second.x && first.y === second.y) {
      continue;
    }
    const command = polygonCommand(
      camera,
      `${id}:${index}`,
      segmentQuad(first, second, width, z),
      fill,
    );
    if (command) {
      commands.push(command);
    }
  }
};

const drawGround = (
  context: CanvasRenderingContext2D,
  camera: Camera,
  view: EyeView,
): void => {
  const direction = {
    x: Math.cos(view.heading),
    y: Math.sin(view.heading),
  };
  const side = { x: -direction.y, y: direction.x };
  const point = (forward: number, across: number): Vec3 => ({
    x: view.position.x + direction.x * forward + side.x * across,
    y: view.position.y + direction.y * forward + side.y * across,
    z: 0,
  });
  const ground = polygonCommand(
    camera,
    "ground",
    [
      point(-10, -190),
      point(240, -190),
      point(240, 190),
      point(-10, 190),
    ],
    "#1b3025",
  );
  if (ground) {
    drawPolygon(context, ground);
  }
};

const drawLand = (
  context: CanvasRenderingContext2D,
  camera: Camera,
  course: Course,
): void => {
  const commands = course.landAreas.flatMap((area) => {
    const command = polygonCommand(
      camera,
      area.id,
      area.points.map((point) => ({ ...point, z: 0.03 })),
      LAND_COLORS[area.category],
      "rgba(190, 220, 190, 0.12)",
    );
    return command ? [command] : [];
  });
  drawSorted(context, commands);
};

const drawRoads = (
  context: CanvasRenderingContext2D,
  camera: Camera,
  course: Course,
  state: RaceState,
  debug: boolean,
  selectedVehicle: VehicleDefinition,
): void => {
  const roads: PolygonCommand[] = [];
  for (const road of course.roads) {
    const passable = isRoadPassable(selectedVehicle.id, road.highway);
    pushLineCommands(
      roads,
      camera,
      `road:${road.id}`,
      road.points,
      course.roadWidth,
      0.06,
      passable ? "#2d3937" : "#6b3430",
    );
    if (!passable) {
      pushLineCommands(
        roads,
        camera,
        `blocked:${road.id}`,
        road.points,
        1.1,
        0.08,
        "#d46a5d",
      );
    }
  }
  drawSorted(context, roads);

  const lap: PolygonCommand[] = [];
  pushLineCommands(
    lap,
    camera,
    "lap",
    course.lap,
    course.roadWidth - 1,
    0.09,
    "#3b4641",
  );
  drawSorted(context, lap);

  const centerlines: PolygonCommand[] = [];
  pushLineCommands(
    centerlines,
    camera,
    "lap-center",
    course.lap,
    0.45,
    0.13,
    "#d8d2aa",
  );
  const targetDistance =
    (state.kind === "finished" ? 1 : state.progress) * course.lapLength;
  for (let index = 1; index < course.lap.length; index += 1) {
    const first = course.lap[index - 1];
    const second = course.lap[index];
    const startDistance = course.lapCumulative[index - 1];
    const endDistance = course.lapCumulative[index];
    if (
      !first ||
      !second ||
      startDistance === undefined ||
      endDistance === undefined ||
      startDistance >= targetDistance
    ) {
      continue;
    }
    const amount = Math.min(
      1,
      (targetDistance - startDistance) / (endDistance - startDistance),
    );
    const partial = {
      x: first.x + (second.x - first.x) * amount,
      y: first.y + (second.y - first.y) * amount,
    };
    pushLineCommands(
      centerlines,
      camera,
      `progress:${index}`,
      [first, partial],
      0.85,
      0.17,
      "#f5c451",
    );
  }
  if (debug) {
    for (const road of course.roads) {
      pushLineCommands(
        centerlines,
        camera,
        `debug:${road.id}`,
        road.points,
        0.28,
        0.2,
        "#5dd0d3",
      );
    }
  }
  drawSorted(context, centerlines);
};

const drawBuildings = (
  context: CanvasRenderingContext2D,
  camera: Camera,
  course: Course,
  view: EyeView,
): void => {
  const commands: PolygonCommand[] = [];
  for (const building of course.buildings) {
    const center = building.footprint.reduce(
      (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
      { x: 0, y: 0 },
    );
    const count = Math.max(1, building.footprint.length);
    if (
      Math.hypot(
        center.x / count - view.position.x,
        center.y / count - view.position.y,
      ) > 210
    ) {
      continue;
    }
    for (let index = 1; index < building.footprint.length; index += 1) {
      const first = building.footprint[index - 1];
      const second = building.footprint[index];
      if (!first || !second) {
        continue;
      }
      const side = polygonCommand(
        camera,
        `${building.id}:side:${index}`,
        [
          { ...first, z: 0.1 },
          { ...second, z: 0.1 },
          { ...second, z: building.height },
          { ...first, z: building.height },
        ],
        index % 2 === 0 ? "#7e796c" : "#706c61",
        "#56564f",
      );
      if (side) {
        commands.push(side);
      }
    }
    const roof = polygonCommand(
      camera,
      `${building.id}:roof`,
      building.footprint.map((point) => ({ ...point, z: building.height })),
      "#aaa28c",
      "#66635a",
    );
    if (roof) {
      commands.push(roof);
    }
  }
  drawSorted(context, commands);
};

const drawCourseMarks = (
  context: CanvasRenderingContext2D,
  camera: Camera,
  course: Course,
  state: RaceState,
): void => {
  const start = pointAtProgress(course, 0);
  const normal = { x: -start.tangent.y, y: start.tangent.x };
  for (let index = 0; index < 8; index += 1) {
    const from = (index / 8 - 0.5) * course.roadWidth;
    const to = ((index + 1) / 8 - 0.5) * course.roadWidth;
    const command = polygonCommand(
      camera,
      `start:${index}`,
      [
        {
          x: start.point.x + normal.x * from,
          y: start.point.y + normal.y * from,
          z: 0.22,
        },
        {
          x: start.point.x + normal.x * to,
          y: start.point.y + normal.y * to,
          z: 0.22,
        },
        {
          x: start.point.x + normal.x * to + start.tangent.x * 0.9,
          y: start.point.y + normal.y * to + start.tangent.y * 0.9,
          z: 0.22,
        },
        {
          x: start.point.x + normal.x * from + start.tangent.x * 0.9,
          y: start.point.y + normal.y * from + start.tangent.y * 0.9,
          z: 0.22,
        },
      ],
      index % 2 === 0 ? "#f3ecd2" : "#d95b49",
    );
    if (command) {
      drawPolygon(context, command);
    }
  }

  course.checkpointFractions.forEach((fraction, index) => {
    const checkpoint = pointAtProgress(course, fraction);
    const projected = projectPoint(camera, { ...checkpoint.point, z: 0.8 });
    if (!projected) {
      return;
    }
    const radius = Math.max(
      3,
      Math.min(15, (2.2 / projected.depth) * camera.focalLength),
    );
    context.beginPath();
    context.arc(projected.x, projected.y, radius, 0, Math.PI * 2);
    context.fillStyle = index < state.checkpointsPassed ? "#f5c451" : "#17231f";
    context.fill();
    context.strokeStyle =
      index < state.checkpointsPassed ? "#fff1ba" : "#a7b8ad";
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle =
      index < state.checkpointsPassed ? "#17231f" : "#edf2ed";
    context.font = `700 ${Math.max(8, radius)}px ui-monospace, monospace`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      checkpointLabel(course, index),
      projected.x,
      projected.y,
    );
  });
};

const drawBoostPads = (
  context: CanvasRenderingContext2D,
  camera: Camera,
  scene: SceneOptions,
): void => {
  const commands: PolygonCommand[] = [];
  for (const pad of scene.pads) {
    const active = pad.id === scene.boostPadId;
    const base = polygonCommand(
      camera,
      `pad:${pad.id}`,
      padFootprint(pad).map((point) => ({ ...point, z: 0.21 })),
      active ? "#7de3f3" : "#2fa8c9",
      "#eafaff",
    );
    if (base) {
      commands.push(base);
    }
    const along = { x: Math.cos(pad.heading), y: Math.sin(pad.heading) };
    const across = { x: -along.y, y: along.x };
    const chevronTip = 2.2;
    const chevronThickness = 1.1;
    const chevronSide = PAD_WIDTH_METERS / 2 - 1.3;
    for (let index = 0; index < 2; index += 1) {
      const offset = (index - 0.5) * 2.4;
      const corner = (forward: number, side: number): Vec3 => ({
        x: pad.x + along.x * (offset + forward) + across.x * side,
        y: pad.y + along.y * (offset + forward) + across.y * side,
        z: 0.24,
      });
      const chevron = polygonCommand(
        camera,
        `pad:${pad.id}:chevron:${index}`,
        [
          corner(chevronTip, 0),
          corner(0, chevronSide),
          corner(-chevronThickness, chevronSide),
          corner(chevronTip - chevronThickness, 0),
          corner(-chevronThickness, -chevronSide),
          corner(0, -chevronSide),
        ],
        active ? "#0e2c34" : "#eafaff",
      );
      if (chevron) {
        commands.push(chevron);
      }
    }
  }
  drawSorted(context, commands);
};

const drawPlacementPreview = (
  context: CanvasRenderingContext2D,
  camera: Camera,
  build: BuildView,
): void => {
  const { walker } = build;
  const along = { x: Math.cos(walker.heading), y: Math.sin(walker.heading) };
  const across = { x: -along.y, y: along.x };
  const corner = (forward: number, side: number): Vec3 => ({
    x: walker.position.x + along.x * forward + across.x * side,
    y: walker.position.y + along.y * forward + across.y * side,
    z: 0.26,
  });
  const half = PAD_LENGTH_METERS / 2;
  const side = PAD_WIDTH_METERS / 2;
  const command = polygonCommand(
    camera,
    "placement-preview",
    [
      corner(half, side),
      corner(half, -side),
      corner(-half, -side),
      corner(-half, side),
    ],
    build.placementValid
      ? "rgba(100, 194, 139, 0.5)"
      : "rgba(227, 91, 69, 0.5)",
    build.placementValid ? "#8ff0b6" : "#ffb3a5",
  );
  if (command) {
    drawPolygon(context, command);
  }
};

const drawVehicle = (
  context: CanvasRenderingContext2D,
  camera: Camera,
  state: RaceState,
  selectedVehicle: VehicleDefinition,
): void => {
  const direction = {
    x: Math.cos(state.vehicle.heading),
    y: Math.sin(state.vehicle.heading),
  };
  const side = { x: -direction.y, y: direction.x };
  const corner = (forward: number, across: number, z: number): Vec3 => ({
    x: state.vehicle.position.x + direction.x * forward + side.x * across,
    y: state.vehicle.position.y + direction.y * forward + side.y * across,
    z,
  });
  const bodyColor = selectedVehicle.color;
  const faces = [
    polygonCommand(
      camera,
      "car:left",
      [
        corner(-2.1, -1.05, 0.25),
        corner(2.1, -1.05, 0.25),
        corner(1.8, -1.05, 1.15),
        corner(-1.8, -1.05, 1.15),
      ],
      selectedVehicle.darkColor,
    ),
    polygonCommand(
      camera,
      "car:right",
      [
        corner(-2.1, 1.05, 0.25),
        corner(2.1, 1.05, 0.25),
        corner(1.8, 1.05, 1.15),
        corner(-1.8, 1.05, 1.15),
      ],
      selectedVehicle.darkColor,
    ),
    polygonCommand(
      camera,
      "car:roof",
      [
        corner(-1.8, -1.05, 1.15),
        corner(1.8, -1.05, 1.15),
        corner(1.8, 1.05, 1.15),
        corner(-1.8, 1.05, 1.15),
      ],
      bodyColor,
      "#8f392f",
    ),
    polygonCommand(
      camera,
      "car:window",
      [
        corner(-0.7, -0.82, 1.18),
        corner(0.8, -0.82, 1.18),
        corner(0.8, 0.82, 1.18),
        corner(-0.7, 0.82, 1.18),
      ],
      "#ecd8aa",
    ),
  ].filter((command): command is PolygonCommand => command !== null);
  drawSorted(context, faces);
};

export const renderChaseView = (
  context: CanvasRenderingContext2D,
  course: Course,
  state: RaceState,
  debug: boolean,
  selectedVehicle: VehicleDefinition,
  width: number,
  height: number,
  scene: SceneOptions,
): void => {
  const view = sceneEye(state, scene);
  const camera = makeCamera(view, width, height);
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#75909a");
  sky.addColorStop(0.56, "#31483f");
  sky.addColorStop(1, "#17251f");
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);
  drawGround(context, camera, view);
  drawLand(context, camera, course);
  drawRoads(context, camera, course, state, debug, selectedVehicle);
  drawBuildings(context, camera, course, view);
  drawCourseMarks(context, camera, course, state);
  if (scene.build) {
    drawPlacementPreview(context, camera, scene.build);
  }
  drawBoostPads(context, camera, scene);
  if (!scene.build) {
    drawVehicle(context, camera, state, selectedVehicle);
  }
};