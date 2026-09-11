/** 壊れた検証スクリプト。直接実行しても fail-closed。npm run browser:verify も無効化済み。 */
console.error(
  "scripts/verify-browser.mjs は復元ギャップで壊れています（startSnapshot is not defined）。npm run build-mode:verify を使ってください。",
);
process.exit(1);

import { mkdir, readFile, writeFile } from "node:fs/promises";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:43177/";
const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const OUTPUT_DIR = process.env.PROOF_DIR ?? "/tmp/kinjo-race-proof";

class ProtocolClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    });
  }

  send(method, params = {}) {
    if (!this.socket) {
      throw new Error("Browser protocol connection is not open.");
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    this.socket?.close();
  }
}

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const targets = await fetch(`${CDP_URL}/json/list`).then((response) =>
  response.json(),
);
const target = targets.find((candidate) => candidate.type === "page");
if (!target) {
  throw new Error("No browser page target is available.");
}
console.log("ブラウザ対象を検出しました。");
const client = new ProtocolClient(target.webSocketDebuggerUrl);
await client.open();
console.log("ブラウザへ接続しました。");

const requests = [];
const exceptions = [];
client.on("Network.requestWillBeSent", ({ request }) => {
  requests.push(request.url);
});
client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
  exceptions.push(exceptionDetails.text);
});
await client.send("Network.enable");
await client.send("Runtime.enable");
await client.send("Page.enable");
await client.send("Page.navigate", { url: APP_URL });
await wait(1_200);
console.log("画面を読み込みました。");

const evaluate = async (expression, awaitPromise = false) => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text);
  }
  return result.result.value;
};

await evaluate(
  `localStorage.removeItem("kinjo-race:prepared-fixture:v1")`,
);
await client.send("Page.navigate", { url: APP_URL });
await wait(1_000);

const keyDefinitions = {
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  g: { code: "KeyG", keyCode: 71 },
  r: { code: "KeyR", keyCode: 82 },
  t: { code: "KeyT", keyCode: 84 },
  "1": { code: "Digit1", keyCode: 49 },
  "2": { code: "Digit2", keyCode: 50 },
};
const held = new Set();
const dispatch = async (key, down) => {
  const definition = keyDefinitions[key];
  await client.send("Input.dispatchKeyEvent", {
    type: down ? "rawKeyDown" : "keyUp",
    key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
  });
};
const setKey = async (key, down) => {
  if (down === held.has(key)) {
    return;
  }
  if (down) {
    held.add(key);
  } else {
    held.delete(key);
  }
  await dispatch(key, down);
};
const tap = async (key) => {
  await dispatch(key, true);
  await dispatch(key, false);
};
const releaseDrivingKeys = async () => {
  for (const key of [...held]) {
    await setKey(key, false);
  }
};

const touchPointerIds = {
  accelerate: 101,
  brake: 102,
  left: 103,
  right: 104,
};
const activeTouchActions = new Set();
const setTouchAction = async (action, down) => {
  if (down === activeTouchActions.has(action)) {
    return;
  }
  if (down) {
    activeTouchActions.add(action);
  } else {
    activeTouchActions.delete(action);
  }
  await evaluate(`(() => {
    const button = document.querySelector('[data-touch-action="${action}"]');
    if (!button) {
      throw new Error("Touch control is absent.");
    }
    button.dispatchEvent(new PointerEvent(
      "${down ? "pointerdown" : "pointerup"}",
      {
        bubbles: true,
        cancelable: true,
        pointerId: ${touchPointerIds[action]},
        pointerType: "touch",
        isPrimary: ${action === "accelerate"},
        buttons: ${down ? 1 : 0},
        pressure: ${down ? 0.5 : 0}
      }
    ));
  })()`);
};
const releaseTouchActions = async () => {
  for (const action of [...activeTouchActions]) {
    await setTouchAction(action, false);
  }
};

const capture = async (name) => {
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await mkdir(OUTPUT_DIR, { recursive: true });
  const path = `${OUTPUT_DIR}/${name}.png`;
  await writeFile(path, Buffer.from(screenshot.data, "base64"));
  return path;
};

await setKey("ArrowUp", true);
await wait(700);
await setKey("ArrowUp", false);
await wait(300);
const chaseScreenshot = await capture("追従表示");
console.log("追従表示を保存しました。");

await setKey("ArrowUp", true);
await wait(700);
await setKey("ArrowUp", false);
await wait(300);
await tap("t");
await wait(300);
const topDownMode = await evaluate(
  `document.querySelector("#view-badge")?.textContent`,
);
const topDownScreenshot = await capture("俯瞰表示");
console.log("俯瞰表示を保存しました。");
await tap("g");
await wait(200);
const debugVisible = await evaluate(
  `!document.querySelector("#debug-badge")?.hidden`,
);
await tap("g");
await tap("t");
await tap("r");
await wait(200);

const fixture = JSON.parse(
  await readFile(new URL("../src/data/neighborhood.json", import.meta.url)),
);
const latitudeRadians =
  (((fixture.bbox.south + fixture.bbox.north) / 2) * Math.PI) / 180;
const metersPerLongitude = 111_320 * Math.cos(latitudeRadians);
const project = (point) => ({
  x: (point[2] - fixture.bbox.west) * metersPerLongitude,
  y: (fixture.bbox.north - point[1]) * 111_320,
});
const nodePoints = new Map();
for (const road of fixture.roads) {
  for (const point of road.points) {
    nodePoints.set(point[0], project(point));
  }
}
const lap = fixture.course.lapNodeIds.map((id) => nodePoints.get(id));
const cumulative = [0];
for (let index = 1; index < lap.length; index += 1) {
  const first = lap[index - 1];
  const second = lap[index];
  cumulative.push(
    cumulative[index - 1] +
      Math.hypot(second.x - first.x, second.y - first.y),
  );
}
const lapLength = cumulative.at(-1);
const minimapWidth = 156;
const minimapHeight = 120;
const minimapMargin = 18;
const minimapPadding = 10;
const lapXs = lap.map((point) => point.x);
const lapYs = lap.map((point) => point.y);
const lapMinX = Math.min(...lapXs);
const lapMaxX = Math.max(...lapXs);
const lapMinY = Math.min(...lapYs);
const lapMaxY = Math.max(...lapYs);
const lapWorldWidth = lapMaxX - lapMinX;
const lapWorldHeight = lapMaxY - lapMinY;
const minimapWorldPadding =
  Math.max(lapWorldWidth, lapWorldHeight) * 0.08;
const minimapPaddedWidth = lapWorldWidth + minimapWorldPadding * 2;
const minimapPaddedHeight = lapWorldHeight + minimapWorldPadding * 2;
const minimapScale = Math.min(
  (minimapWidth - minimapPadding * 2) / minimapPaddedWidth,
  (minimapHeight - minimapPadding * 2) / minimapPaddedHeight,
);
const minimapWorldX = lapMinX - minimapWorldPadding;
const minimapWorldY = lapMinY - minimapWorldPadding;
const minimapOffsetX =
  (minimapWidth - minimapPaddedWidth * minimapScale) / 2;
const minimapOffsetY =
  (minimapHeight - minimapPaddedHeight * minimapScale) / 2;

const expectedMinimap = (snapshot) => ({
  x:
    snapshot.canvasWidth -
    minimapWidth -
    minimapMargin +
    minimapOffsetX +
    (snapshot.x - minimapWorldX) * minimapScale,
  y:
    snapshot.canvasHeight -
    minimapHeight -
    minimapMargin +
    minimapOffsetY +
    (snapshot.y - minimapWorldY) * minimapScale,
});

const minimapMatches = (snapshot) => {
  const expected = expectedMinimap(snapshot);
  const headingDifference = Math.atan2(
    Math.sin(snapshot.minimap.heading - snapshot.heading),
    Math.cos(snapshot.minimap.heading - snapshot.heading),
  );
  return (
    snapshot.minimap.visible &&
    snapshot.minimap.orientation === "north-up" &&
    Math.abs(snapshot.minimap.x - expected.x) <= 1.25 &&
    Math.abs(snapshot.minimap.y - expected.y) <= 1.25 &&
    Math.abs(headingDifference) <= 0.001
  );
};

const nearestDistance = (position) => {
  let best = { distance: Number.POSITIVE_INFINITY, progressDistance: 0 };
  for (let index = 1; index < lap.length; index += 1) {
    const first = lap[index - 1];
    const second = lap[index];
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const squaredLength = dx * dx + dy * dy;
    const amount = Math.max(
      0,
      Math.min(
        1,
        ((position.x - first.x) * dx + (position.y - first.y) * dy) /
          squaredLength,
      ),
    );
    const point = {
      x: first.x + dx * amount,
      y: first.y + dy * amount,
    };
    const distance = Math.hypot(position.x - point.x, position.y - point.y);
    if (distance < best.distance) {
      best = {
        distance,
        progressDistance:
          cumulative[index - 1] + Math.sqrt(squaredLength) * amount,
      };
    }
  }
  return best;
};

const pointAtDistance = (distance) => {
  const normalized = ((distance % lapLength) + lapLength) % lapLength;
  let index = 1;
  while (cumulative[index] < normalized && index < lap.length - 1) {
    index += 1;
  }
  const first = lap[index - 1];
  const second = lap[index];
  const amount =
    (normalized - cumulative[index - 1]) /
    (cumulative[index] - cumulative[index - 1]);
  return {
    x: first.x + (second.x - first.x) * amount,
    y: first.y + (second.y - first.y) * amount,
  };
};

const vehicleSnapshot = () =>
  evaluate(`(() => {
    const data = document.querySelector("#race-canvas")?.dataset;
    return {
      x: Number(data?.vehicleX),
      y: Number(data?.vehicleY),
      heading: Number(data?.vehicleHeading),
      speed: Number(data?.vehicleSpeed),
      selectedVehicle: data?.selectedVehicle,
      maxSpeed: Number(data?.vehicleMaxSpeed),
      blockedHits: Number(data?.blockedHits),
      blockedActive: data?.blockedActive === "true",
      blockedHighway: data?.blockedHighway,
      inputSource: data?.inputSource,
      activeTouchCount: Number(data?.activeTouchCount),
      touchActions: data?.touchActions,
      kind: data?.raceKind,
      checkpoints: Number(document.querySelector("#checkpoints")?.textContent),
      progress: document.querySelector("#progress-label")?.textContent
    };
  })()`);

const createLapDriver = (sourceFixture) => {
  const latitudeRadians =
    (((sourceFixture.bbox.south + sourceFixture.bbox.north) / 2) *
      Math.PI) /
    180;
  const metersPerLongitude =
    111_320 * Math.cos(latitudeRadians);
  const projectPoint = (point) => ({
    x:
      (point[2] - sourceFixture.bbox.west) *
      metersPerLongitude,
    y: (sourceFixture.bbox.north - point[1]) * 111_320,
  });
  const points = new Map();
  for (const road of sourceFixture.roads) {
    for (const point of road.points) {
      points.set(point[0], projectPoint(point));
    }
  }
  const courseLap = sourceFixture.course.lapNodeIds.map((id) =>
    points.get(id),
  );
  const courseCumulative = [0];
  for (let index = 1; index < courseLap.length; index += 1) {
    const first = courseLap[index - 1];
    const second = courseLap[index];
    courseCumulative.push(
      courseCumulative[index - 1] +
        Math.hypot(second.x - first.x, second.y - first.y),
    );
  }
  const courseLength = courseCumulative.at(-1);
  return {
    nearest(position) {
      let best = {
        distance: Number.POSITIVE_INFINITY,
        progressDistance: 0,
      };
      for (let index = 1; index < courseLap.length; index += 1) {
        const first = courseLap[index - 1];
        const second = courseLap[index];
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const squaredLength = dx * dx + dy * dy;
        const amount = Math.max(
          0,
          Math.min(
            1,
            ((position.x - first.x) * dx +
              (position.y - first.y) * dy) /
              squaredLength,
          ),
        );
        const point = {
          x: first.x + dx * amount,
          y: first.y + dy * amount,
        };
        const distance = Math.hypot(
          position.x - point.x,
          position.y - point.y,
        );
        if (distance < best.distance) {
          best = {
            distance,
            progressDistance:
              courseCumulative[index - 1] +
              Math.sqrt(squaredLength) * amount,
          };
        }
      }
      return best;
    },
    pointAt(distance) {
      const normalized =
        ((distance % courseLength) + courseLength) % courseLength;
      let index = 1;
      while (
        courseCumulative[index] < normalized &&
        index < courseLap.length - 1
      ) {
        index += 1;
      }
      const first = courseLap[index - 1];
      const second = courseLap[index];
      const amount =
        (normalized - courseCumulative[index - 1]) /
        (courseCumulative[index] - courseCumulative[index - 1]);
      return {
        x: first.x + (second.x - first.x) * amount,
        y: first.y + (second.y - first.y) * amount,
      };
    },
  };
};

const delays = [300, 400, 500, 350];
let driveTicks = 0;
let driveSnapshot = await vehicleSnapshot();
let midLapScreenshot = null;
while (driveSnapshot.kind !== "finished" && driveTicks < 420) {
  const position = { x: driveSnapshot.x, y: driveSnapshot.y };
  const nearest = nearestDistance(position);
  const targetPoint = pointAtDistance(nearest.progressDistance + 16);
  const targetHeading = Math.atan2(
    targetPoint.y - position.y,
    targetPoint.x - position.x,
  );
  const headingError = Math.atan2(
    Math.sin(targetHeading - driveSnapshot.heading),
    Math.cos(targetHeading - driveSnapshot.heading),
  );
  const coasting = Math.abs(headingError) > 1.05;
  await setKey("ArrowUp", !coasting);
  await setKey("ArrowDown", false);
  await setKey("ArrowLeft", headingError < -0.05);
  await setKey("ArrowRight", headingError > 0.05);
  await wait(delays[driveTicks % delays.length]);
  driveSnapshot = await vehicleSnapshot();
  if (
    midLapScreenshot === null &&
    driveSnapshot.kind === "running" &&
    driveSnapshot.checkpoints >= 2
  ) {
    midLapScreenshot = await capture("追従途中");
    console.log("追従途中を保存しました。");
  }
  driveTicks += 1;
}
await releaseDrivingKeys();
const finishScreenshot =
  driveSnapshot.kind === "finished" ? await capture("完走") : null;
const minimapSnapshots = [
  startSnapshot,
  topDownSnapshot,
  ...midLapProofs.map((proof) => proof.snapshot),
  driveSnapshot,
];
const minimapPositionDelta =
  midLapProofs.length > 0
    ? Math.hypot(
        midLapProofs[0].snapshot.minimap.x - startSnapshot.minimap.x,
        midLapProofs[0].snapshot.minimap.y - startSnapshot.minimap.y,
      )
    : 0;
const minimapAssertions = {
  全状態で座標一致: minimapSnapshots.every(minimapMatches),
  両視点で表示:
    startSnapshot.minimap.visible &&
    startSnapshot.viewMode === "chase" &&
    topDownSnapshot.minimap.visible &&
    topDownSnapshot.viewMode === "topDown",
  途中で矢印移動: minimapPositionDelta > 10,
  固定方位:
    minimapSnapshots.every(
      (snapshot) => snapshot.minimap.orientation === "north-up",
    ),
};

await tap("1");
await wait(250);
await tap("t");
await tap("g");
await wait(250);
const blockedRoadMapScreenshot = await capture("通行不可道路表示");
await tap("g");
await tap("t");
await tap("r");
await wait(250);

const blockedDemoNodeIds = [
  365292733,
  364667959,
  364666474,
  364665902,
  364666473,
  364666472,
  2007105820,
  430093915,
  430093913,
  430093769,
  832681700,
  1673358934,
  1673358944,
  1673358919,
];
const blockedDemoPath = blockedDemoNodeIds.map((nodeId) =>
  nodePoints.get(nodeId),
);
if (blockedDemoPath.some((point) => point === undefined)) {
  throw new Error("通行不可デモ経路のノードが固定データにありません。");
}
let blockedPathIndex = 1;
let blockedTicks = 0;
let blockedSnapshot = await vehicleSnapshot();
let blockedBounceScreenshot = null;
while (
  blockedSnapshot.blockedHits === 0 &&
  blockedTicks < 600 &&
  blockedPathIndex < blockedDemoPath.length
) {
  const position = { x: blockedSnapshot.x, y: blockedSnapshot.y };
  const segmentStart = blockedDemoPath[blockedPathIndex - 1];
  let target = blockedDemoPath[blockedPathIndex];
  const segmentX = target.x - segmentStart.x;
  const segmentY = target.y - segmentStart.y;
  const segmentSquaredLength =
    segmentX * segmentX + segmentY * segmentY;
  const segmentProgress =
    segmentSquaredLength === 0
      ? 1
      : ((position.x - segmentStart.x) * segmentX +
          (position.y - segmentStart.y) * segmentY) /
        segmentSquaredLength;
  if (
    Math.hypot(target.x - position.x, target.y - position.y) < 8 ||
    segmentProgress >= 0.92
  ) {
    blockedPathIndex += 1;
    target = blockedDemoPath[blockedPathIndex] ?? target;
  }
  const targetHeading = Math.atan2(
    target.y - position.y,
    target.x - position.x,
  );
  const headingError = Math.atan2(
    Math.sin(targetHeading - blockedSnapshot.heading),
    Math.cos(targetHeading - blockedSnapshot.heading),
  );
  const absoluteSpeed = Math.abs(blockedSnapshot.speed);
  await setKey(
    "ArrowUp",
    absoluteSpeed < 5.5 &&
      (Math.abs(headingError) < 1.2 || absoluteSpeed < 0.8),
  );
  await setKey("ArrowDown", absoluteSpeed > 7);
  await setKey("ArrowLeft", headingError < -0.05);
  await setKey("ArrowRight", headingError > 0.05);
  await wait(200);
  blockedSnapshot = await vehicleSnapshot();
  if (blockedSnapshot.blockedActive) {
    blockedBounceScreenshot = await capture("通行不可バウンド");
  }
  blockedTicks += 1;
}
await releaseDrivingKeys();
const blockedPosition = {
  x: blockedSnapshot.x,
  y: blockedSnapshot.y,
};
await setKey("ArrowDown", true);
await wait(1_200);
await setKey("ArrowDown", false);
await wait(250);
const blockedRecoverySnapshot = await vehicleSnapshot();
const blockedRecoveryDistance = Math.hypot(
  blockedRecoverySnapshot.x - blockedPosition.x,
  blockedRecoverySnapshot.y - blockedPosition.y,
);

await tap("r");
await wait(200);
await setKey("ArrowDown", true);
await setKey("ArrowRight", true);
await wait(6_000);
await releaseDrivingKeys();
const reverseCheckpoints = await evaluate(
  `Number(document.querySelector("#checkpoints")?.textContent)`,
);
await tap("r");
await wait(200);
const resetState = await vehicleSnapshot();

const frameTimes = await evaluate(
  `(async () => {
    const samples = [];
    let previous = performance.now();
    for (let index = 0; index < 180; index += 1) {
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      samples.push(now - previous);
      previous = now;
    }
    samples.sort((a, b) => a - b);
    return {
      average: samples.reduce((sum, value) => sum + value, 0) / samples.length,
      p95: samples[Math.floor(samples.length * 0.95)],
      maximum: samples.at(-1)
    };
  })()`,
  true,
);

await client.send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
  screenWidth: 390,
  screenHeight: 844,
});
await client.send("Emulation.setTouchEmulationEnabled", {
  enabled: true,
  maxTouchPoints: 5,
});
await client.send("Page.navigate", { url: APP_URL });
await wait(1_200);

const mobileLayoutSnapshot = () =>
  evaluate(`(() => {
    const controls = document.querySelector("#touch-controls");
    const attribution = document.querySelector("#touch-controls > a");
    const canvas = document.querySelector("#race-canvas");
    const controlsRect = controls?.getBoundingClientRect();
    const attributionRect = attribution?.getBoundingClientRect();
    const canvasRect = canvas?.getBoundingClientRect();
    return {
      width: innerWidth,
      height: innerHeight,
      controlsVisible:
        controls !== null && getComputedStyle(controls).display !== "none",
      buttonCount: controls?.querySelectorAll("button").length ?? 0,
      controlsInViewport:
        controlsRect !== undefined &&
        controlsRect.top >= 0 &&
        controlsRect.bottom <= innerHeight,
      attributionVisible:
        attributionRect !== undefined &&
        attributionRect.top >= 0 &&
        attributionRect.bottom <= innerHeight,
      controlsBelowCanvas:
        controlsRect !== undefined &&
        canvasRect !== undefined &&
        controlsRect.top >= canvasRect.bottom
    };
  })()`);

const touchPortraitLayout = await mobileLayoutSnapshot();
const touchPortraitScreenshot = await capture("タッチ縦画面");
let touchSnapshot = await vehicleSnapshot();
let touchTicks = 0;
let touchMidScreenshot = null;
let multiTouchObserved = false;
while (touchSnapshot.kind !== "finished" && touchTicks < 420) {
  const position = { x: touchSnapshot.x, y: touchSnapshot.y };
  const nearest = nearestDistance(position);
  const targetPoint = pointAtDistance(nearest.progressDistance + 16);
  const targetHeading = Math.atan2(
    targetPoint.y - position.y,
    targetPoint.x - position.x,
  );
  const headingError = Math.atan2(
    Math.sin(targetHeading - touchSnapshot.heading),
    Math.cos(targetHeading - touchSnapshot.heading),
  );
  const coasting = Math.abs(headingError) > 1.05;
  await setTouchAction("accelerate", !coasting);
  await setTouchAction("brake", false);
  await setTouchAction("left", headingError < -0.05);
  await setTouchAction("right", headingError > 0.05);
  await wait(delays[touchTicks % delays.length]);
  touchSnapshot = await vehicleSnapshot();
  multiTouchObserved =
    multiTouchObserved ||
    (touchSnapshot.inputSource === "touch" &&
      touchSnapshot.activeTouchCount >= 2 &&
      touchSnapshot.touchActions.includes("accelerate") &&
      (touchSnapshot.touchActions.includes("left") ||
        touchSnapshot.touchActions.includes("right")));
  if (
    touchMidScreenshot === null &&
    touchSnapshot.kind === "running" &&
    touchSnapshot.checkpoints >= 2
  ) {
    touchMidScreenshot = await capture("タッチ走行途中");
    console.log("タッチ走行途中を保存しました。");
  }
  touchTicks += 1;
}
await releaseTouchActions();
const touchFinishScreenshot =
  touchSnapshot.kind === "finished" ? await capture("タッチ完走") : null;

await client.send("Emulation.setDeviceMetricsOverride", {
  width: 844,
  height: 390,
  deviceScaleFactor: 1,
  mobile: true,
  screenWidth: 844,
  screenHeight: 390,
});
await wait(500);
const touchLandscapeLayout = await mobileLayoutSnapshot();
const touchLandscapeScreenshot = await capture("タッチ横画面");

const sampleFixtureText = await readFile(
  new URL("../src/data/free-range-sample.json", import.meta.url),
  "utf8",
);
const sampleFixture = JSON.parse(sampleFixtureText);
const sampleDriver = createLapDriver(sampleFixture);
await client.send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
  screenWidth: 390,
  screenHeight: 844,
});
await evaluate(
  `localStorage.setItem(
    "kinjo-race:prepared-fixture:v1",
    ${JSON.stringify(sampleFixtureText)}
  )`,
);
await client.send("Page.navigate", { url: APP_URL });
await wait(1_200);
const preparedCourseName = await evaluate(
  `document.querySelector("#course-name")?.textContent`,
);
const preparedBuildingCount = Number(
  await evaluate(
    `document.querySelector("#building-count")?.textContent`,
  ),
);
await tap("t");
await wait(250);
const preparedCourseScreenshot = await capture("自由範囲コース");
await tap("t");
await wait(250);

const preparedStartSnapshot = await vehicleSnapshot();
let preparedTouchSnapshot = preparedStartSnapshot;
let preparedTouchTicks = 0;
let preparedMidScreenshot = null;
let preparedMidSnapshot = null;
let preparedMultiTouchObserved = false;
while (
  preparedTouchSnapshot.kind !== "finished" &&
  preparedTouchTicks < 420
) {
  const position = {
    x: preparedTouchSnapshot.x,
    y: preparedTouchSnapshot.y,
  };
  const nearest = sampleDriver.nearest(position);
  const targetPoint = sampleDriver.pointAt(
    nearest.progressDistance + 16,
  );
  const targetHeading = Math.atan2(
    targetPoint.y - position.y,
    targetPoint.x - position.x,
  );
  const headingError = Math.atan2(
    Math.sin(targetHeading - preparedTouchSnapshot.heading),
    Math.cos(targetHeading - preparedTouchSnapshot.heading),
  );
  const coasting = Math.abs(headingError) > 1.05;
  await setTouchAction("accelerate", !coasting);
  await setTouchAction("brake", false);
  await setTouchAction("left", headingError < -0.05);
  await setTouchAction("right", headingError > 0.05);
  await wait(delays[preparedTouchTicks % delays.length]);
  preparedTouchSnapshot = await vehicleSnapshot();
  preparedMultiTouchObserved =
    preparedMultiTouchObserved ||
    (preparedTouchSnapshot.inputSource === "touch" &&
      preparedTouchSnapshot.activeTouchCount >= 2);
  if (
    preparedMidScreenshot === null &&
    preparedTouchSnapshot.kind === "running" &&
    preparedTouchSnapshot.checkpoints >= 2
  ) {
    preparedMidScreenshot = await capture("自由範囲走行");
    preparedMidSnapshot = preparedTouchSnapshot;
    console.log("自由範囲走行を保存しました。");
  }
  preparedTouchTicks += 1;
}
await releaseTouchActions();
const preparedFinishScreenshot =
  preparedTouchSnapshot.kind === "finished"
    ? await capture("自由範囲完走")
    : null;
const preparedMinimapMovement = preparedMidSnapshot
  ? Math.hypot(
      preparedMidSnapshot.minimap.x -
        preparedStartSnapshot.minimap.x,
      preparedMidSnapshot.minimap.y -
        preparedStartSnapshot.minimap.y,
    )
  : 0;

await client.send("Page.navigate", { url: APP_URL });
await wait(1_000);
const reloadedPreparedCourseName = await evaluate(
  `document.querySelector("#course-name")?.textContent`,
);
await evaluate(
  `localStorage.removeItem("kinjo-race:prepared-fixture:v1")`,
);
await client.send("Page.navigate", { url: APP_URL });
await wait(1_000);
const restoredDemoCourseName = await evaluate(
  `document.querySelector("#course-name")?.textContent`,
);

const offlineRequestBoundary = requests.length;
const acyclicPayload = {
  elements: [
    {
      type: "way",
      id: 9001,
      nodes: [9101, 9102, 9103, 9104, 9105, 9106, 9107],
      geometry: [0, 1, 2, 3, 4, 5, 6].map((index) => ({
        lat: 35.7015 + index * 0.0001,
        lon: 139.6465 + index * 0.0001,
      })),
      tags: { highway: "residential" },
    },
  ],
};
await evaluate(`(() => {
  globalThis.__prepareFetchCount = 0;
  globalThis.fetch = async () => {
    globalThis.__prepareFetchCount += 1;
    return new Response(
      ${JSON.stringify(JSON.stringify(acyclicPayload))},
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };
})()`);
await evaluate(`(() => {
  const dialog = document.querySelector("#range-dialog");
  dialog?.showModal();
  document.querySelector("#bbox-south").value = "35.701";
  document.querySelector("#bbox-west").value = "139.646";
  document.querySelector("#bbox-north").value = "35.704";
  document.querySelector("#bbox-east").value = "139.650";
  document.querySelector("#prepare-range").click();
})()`);
let failClosedState = "loading";
for (let attempt = 0; attempt < 40; attempt += 1) {
  await wait(250);
  failClosedState = await evaluate(
    `document.querySelector("#range-dialog")?.dataset.state`,
  );
  if (failClosedState !== "loading") {
    break;
  }
}
const failClosedMessage = await evaluate(
  `document.querySelector("#range-error")?.textContent`,
);
const failClosedCourseName = await evaluate(
  `document.querySelector("#course-name")?.textContent`,
);
const failClosedScreenshot = await capture("閉路なし拒否");
const interceptedPrepareRequests = Number(
  await evaluate(`globalThis.__prepareFetchCount`),
);

const offlineRequests = requests.slice(0, offlineRequestBoundary);
const localRequests = offlineRequests.filter((url) => {
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
});
const report = {
  初期通信件数: offlineRequests.length,
  ローカル通信件数: localRequests.length,
  外部通信: offlineRequests.filter((url) => !localRequests.includes(url)),
  明示準備の模擬通信件数: interceptedPrepareRequests,
  実行時例外: exceptions,
  ミニマップ開始画像: startScreenshot,
  ミニマップ途中画像: midLapProofs.map((proof) => proof.path),
  俯瞰画像: topDownScreenshot,
  車両選択画像: alleyRun.selectionScreenshot,
  車両別完走画像: {
    まちぐるま: streetRun.finishScreenshot,
    こみちぐるま: alleyRun.finishScreenshot,
  },
  車両別最高速度画像: {
    まちぐるま: streetRun.maximumSpeedScreenshot,
    こみちぐるま: alleyRun.maximumSpeedScreenshot,
  },
  車両別走行結果: {
    まちぐるま: {
      完走状態: streetRun.snapshot,
      入力更新回数: streetRun.driveTicks,
      最高速度ms: streetRun.maximumObservedSpeed,
    },
    こみちぐるま: {
      完走状態: alleyRun.snapshot,
      入力更新回数: alleyRun.driveTicks,
      最高速度ms: alleyRun.maximumObservedSpeed,
    },
  },
  通行不可道路画像: blockedRoadMapScreenshot,
  通行不可バウンド画像: blockedBounceScreenshot,
  通行不可バウンド結果: {
    状態: blockedSnapshot,
    入力更新回数: blockedTicks,
    後退復帰距離m: blockedRecoveryDistance,
    復帰後: blockedRecoverySnapshot,
  },
  ミニマップ検証: minimapAssertions,
  ミニマップ移動量px: minimapPositionDelta,
  俯瞰切替: topDownMode,
  中心線表示: debugVisible,
  タッチ縦画面画像: touchPortraitScreenshot,
  タッチ横画面画像: touchLandscapeScreenshot,
  タッチ走行途中画像: touchMidScreenshot,
  タッチ完走画像: touchFinishScreenshot,
  タッチ縦画面配置: touchPortraitLayout,
  タッチ横画面配置: touchLandscapeLayout,
  タッチ走行結果: {
    完走状態: touchSnapshot,
    入力更新回数: touchTicks,
    複数指入力: multiTouchObserved,
  },
  自由範囲オフライン結果: {
    地域名: preparedCourseName,
    建物数: preparedBuildingCount,
    コース画像: preparedCourseScreenshot,
    走行画像: preparedMidScreenshot,
    完走画像: preparedFinishScreenshot,
    完走状態: preparedTouchSnapshot,
    入力更新回数: preparedTouchTicks,
    複数指入力: preparedMultiTouchObserved,
    ミニマップ移動量px: preparedMinimapMovement,
    再読込後地域名: reloadedPreparedCourseName,
    デモ復帰後地域名: restoredDemoCourseName,
  },
  失敗閉鎖結果: {
    画像: failClosedScreenshot,
    状態: failClosedState,
    メッセージ: failClosedMessage,
    維持した地域名: failClosedCourseName,
  },
  逆走後の通過数: reverseCheckpoints,
  リセット後: resetState,
  フレーム時間ms: frameTimes,
};
console.log(JSON.stringify(report, null, 2));

await releaseDrivingKeys();
client.close();

if (
  offlineRequests.length !== localRequests.length ||
  exceptions.length > 0 ||
  topDownMode !== "俯瞰表示" ||
  debugVisible !== true ||
  midLapProofs.length !== midLapThresholds.length ||
  Object.values(minimapAssertions).some((result) => result !== true) ||
  streetRun.selectedSnapshot.selectedVehicle !== "street" ||
  alleyRun.selectedSnapshot.selectedVehicle !== "alley" ||
  streetRun.snapshot.kind !== "finished" ||
  streetRun.snapshot.checkpoints !== 4 ||
  alleyRun.snapshot.kind !== "finished" ||
  alleyRun.snapshot.checkpoints !== 4 ||
  streetRun.maximumObservedSpeed < streetRun.snapshot.maxSpeed - 0.15 ||
  alleyRun.maximumObservedSpeed < alleyRun.snapshot.maxSpeed - 0.15 ||
  streetRun.maximumSpeedScreenshot === null ||
  alleyRun.maximumSpeedScreenshot === null ||
  alleyRun.selectionScreenshot === null ||
  blockedBounceScreenshot === null ||
  blockedSnapshot.blockedHits < 1 ||
  blockedSnapshot.blockedHighway !== "service" ||
  blockedRecoveryDistance < 1.5 ||
  touchPortraitLayout.width !== 390 ||
  touchPortraitLayout.height !== 844 ||
  !touchPortraitLayout.controlsVisible ||
  touchPortraitLayout.buttonCount !== 4 ||
  !touchPortraitLayout.controlsInViewport ||
  !touchPortraitLayout.attributionVisible ||
  !touchPortraitLayout.controlsBelowCanvas ||
  touchLandscapeLayout.width !== 844 ||
  touchLandscapeLayout.height !== 390 ||
  !touchLandscapeLayout.controlsVisible ||
  touchLandscapeLayout.buttonCount !== 4 ||
  !touchLandscapeLayout.controlsInViewport ||
  !touchLandscapeLayout.attributionVisible ||
  !touchLandscapeLayout.controlsBelowCanvas ||
  touchSnapshot.kind !== "finished" ||
  touchSnapshot.checkpoints !== 4 ||
  touchMidScreenshot === null ||
  touchFinishScreenshot === null ||
  !multiTouchObserved ||
  preparedCourseName !== "高円寺北・準備例" ||
  preparedBuildingCount < 1 ||
  preparedMidScreenshot === null ||
  preparedFinishScreenshot === null ||
  preparedTouchSnapshot.kind !== "finished" ||
  preparedTouchSnapshot.checkpoints !== 4 ||
  !preparedMultiTouchObserved ||
  preparedMinimapMovement < 5 ||
  reloadedPreparedCourseName !== "高円寺北・準備例" ||
  restoredDemoCourseName !== "宮坂2丁目" ||
  interceptedPrepareRequests !== 1 ||
  failClosedState !== "error" ||
  !failClosedMessage.includes("閉じた周回路") ||
  failClosedCourseName !== "宮坂2丁目" ||
  reverseCheckpoints !== 0 ||
  resetState.kind !== "ready"
) {
  process.exitCode = 1;
}