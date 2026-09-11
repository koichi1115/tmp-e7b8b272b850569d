import { pointAtProgress, type Course, type Vec2 } from "./course";
import type { RaceState } from "./race";
import {
  isRoadPassable,
  type VehicleDefinition,
} from "./vehicles";

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

const makeCamera = (
  state: RaceState,
  width: number,
  height: number,
): Camera => {
  const heading = state.vehicle.heading;
  const direction = { x: Math.cos(heading), y: Math.sin(heading) };
  const position = {
    x: state.vehicle.position.x - direction.x * 20,
    y: state.vehicle.position.y - direction.y * 20,
    z: 12,
  };
  const target = {
    x: state.vehicle.position.x + direction.x * 27,
    y: state.vehicle.position.y + direction.y * 27,
    z: 0.8,
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
  state: RaceState,
): void => {
  const direction = {
    x: Math.cos(state.vehicle.heading),
    y: Math.sin(state.vehicle.heading),
  };
  const side = { x: -direction.y, y: direction.x };
  const point = (forward: number, across: number): Vec3 => ({
    x: state.vehicle.position.x + direction.x * forward + side.x * across,
    y: state.vehicle.position.y + direction.y * forward + side.y * across,
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
  state: RaceState,
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
        center.x / count - state.vehicle.position.x,
        center.y / count - state.vehicle.position.y,
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
    context.fillText(String(index + 1), projected.x, projected.y);
  });
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
): void => {
  const camera = makeCamera(state, width, height);
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#75909a");
  sky.addColorStop(0.56, "#31483f");
  sky.addColorStop(1, "#17251f");
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);
  drawGround(context, camera, state);
  drawLand(context, camera, course);
  drawRoads(context, camera, course, state, debug, selectedVehicle);
  drawBuildings(context, camera, course, state);
  drawCourseMarks(context, camera, course, state);
  drawVehicle(context, camera, state, selectedVehicle);
};