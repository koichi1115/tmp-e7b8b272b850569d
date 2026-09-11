import { mkdir, readFile, writeFile } from "node:fs/promises";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:43177/";
const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const OUTPUT_DIR = process.env.PROOF_DIR ?? "/tmp/kinjo-race-build-proof";

const PREPARED_FIXTURE_KEY = "kinjo-race:prepared-fixture:v1";
const BOOST_PADS_KEY = "kinjo-race:boost-pads:v1";
const ROAD_WIDTH_METERS = 14;
const STREET_MAX_SPEED = 17;

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
await client.send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 860,
  deviceScaleFactor: 1,
  mobile: false,
});

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

await client.send("Page.navigate", { url: APP_URL });
await wait(1_200);
await evaluate(
  `(() => {
    localStorage.removeItem("${PREPARED_FIXTURE_KEY}");
    localStorage.removeItem("${BOOST_PADS_KEY}");
  })()`,
);
await client.send("Page.navigate", { url: APP_URL });
await wait(1_200);
console.log("宮坂デモを読み込みました。");

const keyDefinitions = {
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  b: { code: "KeyB", keyCode: 66 },
  e: { code: "KeyE", keyCode: 69 },
  x: { code: "KeyX", keyCode: 88 },
  t: { code: "KeyT", keyCode: 84 },
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
const releaseKeys = async () => {
  for (const key of [...held]) {
    await setKey(key, false);
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
  console.log(`${name} を保存しました。`);
  return path;
};

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
  cumulative.push(
    cumulative[index - 1] +
      Math.hypot(
        lap[index].x - lap[index - 1].x,
        lap[index].y - lap[index - 1].y,
      ),
  );
}
const lapLength = cumulative.at(-1);

const nearestOnLap = (position) => {
  let best = {
    distance: Number.POSITIVE_INFINITY,
    progressDistance: 0,
    tangent: { x: 1, y: 0 },
  };
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
    const point = { x: first.x + dx * amount, y: first.y + dy * amount };
    const distance = Math.hypot(position.x - point.x, position.y - point.y);
    if (distance < best.distance) {
      const segmentLength = Math.sqrt(squaredLength);
      best = {
        distance,
        progressDistance: cumulative[index - 1] + segmentLength * amount,
        tangent: { x: dx / segmentLength, y: dy / segmentLength },
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

const snapshot = () =>
  evaluate(`(() => {
    const data = document.querySelector("#race-canvas")?.dataset;
    const message = document.querySelector("#build-message");
    return {
      buildMode: data?.buildMode === "true",
      padCount: Number(data?.padCount),
      padIds: data?.padIds ?? "",
      walkerX: Number(data?.walkerX),
      walkerY: Number(data?.walkerY),
      walkerHeading: Number(data?.walkerHeading),
      placementValid: data?.placementValid === "true",
      buildMessage: data?.buildMessage ?? "",
      buildMessageTone: data?.buildMessageTone ?? "",
      messageVisible: message !== null && message.hidden === false,
      messageText: message?.textContent ?? "",
      x: Number(data?.vehicleX),
      y: Number(data?.vehicleY),
      heading: Number(data?.vehicleHeading),
      speed: Number(data?.vehicleSpeed),
      maxSpeed: Number(data?.vehicleMaxSpeed),
      boostedMaxSpeed: Number(data?.boostedMaxSpeed),
      boostActive: data?.boostActive === "true",
      boostRemainingMs: Number(data?.boostRemainingMs),
      boostHits: Number(data?.boostHits),
      kind: data?.raceKind,
      minimapArrowX: Number(data?.minimapArrowX),
      minimapArrowY: Number(data?.minimapArrowY),
      minimapArrowHeading: Number(data?.minimapArrowHeading),
      boostBadgeVisible:
        document.querySelector("#boost-badge")?.hidden === false,
      storedPads: localStorage.getItem("${BOOST_PADS_KEY}"),
      checkpoints: Number(
        document.querySelector("#checkpoints")?.textContent
      ),
      padCountLabel: document.querySelector("#pad-count")?.textContent
    };
  })()`);

const setTouchAction = async (action, down) => {
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
        pointerId: ${{ accelerate: 101, brake: 102, left: 103, right: 104 }[action]},
        pointerType: "touch",
        isPrimary: ${action === "accelerate"},
        buttons: ${down ? 1 : 0},
        pressure: ${down ? 0.5 : 0}
      }
    ));
  })()`);
};

const tapBuildButton = async (action) => {
  await evaluate(`(() => {
    const button = document.querySelector('[data-build-action="${action}"]');
    if (!button) {
      throw new Error("Build control is absent.");
    }
    button.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 201,
      pointerType: "touch",
      isPrimary: true
    }));
    button.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 201,
      pointerType: "touch",
      isPrimary: true
    }));
    button.click();
  })()`);
};

const keyboardInput = {
  set: (action, down) =>
    setKey(
      {
        accelerate: "ArrowUp",
        left: "ArrowLeft",
        right: "ArrowRight",
      }[action],
      down,
    ),
  release: releaseKeys,
};

const touchInput = {
  set: setTouchAction,
  release: async () => {
    for (const action of ["accelerate", "left", "right"]) {
      await setTouchAction(action, false);
    }
  },
};

const walkToPoint = async (
  targetPoint,
  tolerance = 1.2,
  limit = 500,
  input = keyboardInput,
) => {
  let state = await snapshot();
  for (let tick = 0; tick < limit; tick += 1) {
    const position = { x: state.walkerX, y: state.walkerY };
    const gap = Math.hypot(
      targetPoint.x - position.x,
      targetPoint.y - position.y,
    );
    if (gap <= tolerance) {
      break;
    }
    const targetHeading = Math.atan2(
      targetPoint.y - position.y,
      targetPoint.x - position.x,
    );
    const headingError = Math.atan2(
      Math.sin(targetHeading - state.walkerHeading),
      Math.cos(targetHeading - state.walkerHeading),
    );
    await input.set("accelerate", Math.abs(headingError) < 0.6);
    await input.set("left", headingError < -0.04);
    await input.set("right", headingError > 0.04);
    await wait(140);
    state = await snapshot();
  }
  await input.release();
  await wait(150);
  return snapshot();
};

const walkAlongLap = (distance, input = keyboardInput) =>
  walkToPoint(pointAtDistance(distance), 1.2, 500, input);

const checks = {};
const record = (name, value) => {
  checks[name] = value;
  return value;
};

const raceStart = await capture("01-レース開始");
const beforeBuild = await snapshot();
record("初期状態はレースモード", beforeBuild.buildMode === false);
record("初期パッド数が0", beforeBuild.padCount === 0);

await tap("b");
await wait(300);
const buildEntered = await snapshot();
const buildEnteredShot = await capture("02-作成モード開始");
record("Bキーで作成モードへ入る", buildEntered.buildMode === true);

await walkAlongLap(52);
const firstSpot = await snapshot();
await tap("e");
await wait(350);
const firstPlaced = await snapshot();
const firstPlacedShot = await capture("03-1枚目を設置");
record("1枚目を設置できる", firstPlaced.padCount === 1);
record(
  "1枚目が路面の回廊内",
  nearestOnLap({ x: firstSpot.walkerX, y: firstSpot.walkerY }).distance <=
    ROAD_WIDTH_METERS / 2 + 1.2,
);

await walkAlongLap(128);
await tap("e");
await wait(350);
const secondPlaced = await snapshot();
const secondPlacedShot = await capture("04-2枚目を設置");
record("2枚目を設置できる", secondPlaced.padCount === 2);

await tap("x");
await wait(350);
const afterRemove = await snapshot();
record("足元のパッドを撤去できる", afterRemove.padCount === 1);
await tap("e");
await wait(350);
const afterReplace = await snapshot();
record("撤去した場所へ再設置できる", afterReplace.padCount === 2);

const rejectionBase = await snapshot();
const rejectionNearest = nearestOnLap({
  x: rejectionBase.walkerX,
  y: rejectionBase.walkerY,
});
const offRoadTarget = {
  x:
    pointAtDistance(rejectionNearest.progressDistance).x -
    rejectionNearest.tangent.y * (ROAD_WIDTH_METERS / 2 + 6),
  y:
    pointAtDistance(rejectionNearest.progressDistance).y +
    rejectionNearest.tangent.x * (ROAD_WIDTH_METERS / 2 + 6),
};
const offRoad = await walkToPoint(offRoadTarget, 1.0);
const storedBeforeRejection = offRoad.storedPads;
record(
  "路外へ歩いて回廊から出た",
  nearestOnLap({ x: offRoad.walkerX, y: offRoad.walkerY }).distance >
    ROAD_WIDTH_METERS / 2 + 1.2,
);
record("路外では設置予告が無効表示", offRoad.placementValid === false);
await tap("e");
await wait(350);
const rejected = await snapshot();
const rejectedShot = await capture("05-路外は設置拒否");
record("路外の設置は拒否される", rejected.padCount === 2);
record("拒否メッセージを表示する", rejected.messageVisible === true);
record(
  "拒否メッセージが路面の外を告げる",
  rejected.messageText.includes("路面"),
);
record("拒否は赤色表示", rejected.buildMessageTone === "error");
record(
  "拒否で保存内容が変わらない",
  rejected.storedPads === storedBeforeRejection,
);

await tap("b");
await wait(400);
const raceResumed = await snapshot();
const raceResumedShot = await capture("06-レースへ復帰");
record("Bキーでレースモードへ戻る", raceResumed.buildMode === false);
record("復帰後もパッドが残る", raceResumed.padCount === 2);

await tap("t");
await wait(400);
const topDownShot = await capture("06b-俯瞰でパッド確認");
await tap("t");
await wait(300);

const delays = [300, 400, 500, 350];
let driveTicks = 0;
let drive = await snapshot();
let boostShot = null;
let boostSnapshot = null;
let peakSpeed = 0;
let peakBoostedSpeed = 0;
let midLap = null;
while (drive.kind !== "finished" && driveTicks < 420) {
  const position = { x: drive.x, y: drive.y };
  const nearest = nearestOnLap(position);
  const targetPoint = pointAtDistance(nearest.progressDistance + 16);
  const targetHeading = Math.atan2(
    targetPoint.y - position.y,
    targetPoint.x - position.x,
  );
  const headingError = Math.atan2(
    Math.sin(targetHeading - drive.heading),
    Math.cos(targetHeading - drive.heading),
  );
  const coasting = Math.abs(headingError) > 1.05;
  await setKey("ArrowUp", !coasting);
  await setKey("ArrowLeft", headingError < -0.05);
  await setKey("ArrowRight", headingError > 0.05);
  await wait(delays[driveTicks % delays.length]);
  drive = await snapshot();
  if (midLap === null && drive.checkpoints >= 2) {
    midLap = drive;
  }
  peakSpeed = Math.max(peakSpeed, drive.speed);
  if (drive.boostActive) {
    peakBoostedSpeed = Math.max(peakBoostedSpeed, drive.speed);
    if (boostShot === null && drive.speed > drive.maxSpeed) {
      boostSnapshot = drive;
      boostShot = await capture("07-加速中");
    }
  }
  driveTicks += 1;
}
await releaseKeys();
const finishShot =
  drive.kind === "finished" ? await capture("08-完走") : null;
record("加速パッドを2回踏む", drive.boostHits >= 2);
record("加速中の合図を表示する", boostSnapshot?.boostBadgeVisible === true);
record(
  "加速で車両上限を超える",
  peakBoostedSpeed > STREET_MAX_SPEED + 0.5,
);
record(
  "固定上限を超えない",
  peakSpeed <= drive.boostedMaxSpeed + 1e-6,
);
record("1周を完走する", drive.kind === "finished");
record(
  "ミニマップの矢印が走行で動く",
  midLap !== null &&
    Math.hypot(
      midLap.minimapArrowX - raceResumed.minimapArrowX,
      midLap.minimapArrowY - raceResumed.minimapArrowY,
    ) > 5,
);
record(
  "ミニマップの向きが車体と一致する",
  midLap !== null &&
    Math.abs(
      Math.atan2(
        Math.sin(midLap.minimapArrowHeading - midLap.heading),
        Math.cos(midLap.minimapArrowHeading - midLap.heading),
      ),
    ) <= 0.001,
);
record("ゲートを4つ通過する", drive.checkpoints === 4);

await client.send("Page.navigate", { url: APP_URL });
await wait(1_400);
const reloaded = await snapshot();
const reloadShot = await capture("09-再読込で復元");
record("再読込後もパッドが2枚残る", reloaded.padCount === 2);
record(
  "再読込後のパッド識別子が一致する",
  reloaded.padIds === raceResumed.padIds && reloaded.padIds !== "",
);
record("側面表示のパッド数も一致する", reloaded.padCountLabel === "2");

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
await wait(1_400);

const touchLayout = () =>
  evaluate(`(() => {
    const controls = document.querySelector("#touch-controls");
    const attribution = document.querySelector("#touch-controls > a");
    const visible = (selector) => {
      const node = document.querySelector(selector);
      return node !== null && getComputedStyle(node).display !== "none";
    };
    return {
      controlsVisible:
        controls !== null && getComputedStyle(controls).display !== "none",
      driveButtons:
        controls?.querySelectorAll("[data-touch-action]").length ?? 0,
      mode: controls?.dataset.mode,
      enterVisible: visible('[data-build-action="enter"]'),
      placeVisible: visible('[data-build-action="place"]'),
      removeVisible: visible('[data-build-action="remove"]'),
      exitVisible: visible('[data-build-action="exit"]'),
      attributionText: attribution?.textContent?.trim() ?? "",
      attributionVisible:
        attribution !== null &&
        getComputedStyle(attribution).display !== "none"
    };
  })()`);

const touchRaceLayout = await touchLayout();
record("タッチ操作面が表示される", touchRaceLayout.controlsVisible === true);
record("走行ボタンが4つ残る", touchRaceLayout.driveButtons === 4);
record("レース時はつくるボタンだけ", 
  touchRaceLayout.enterVisible === true &&
    touchRaceLayout.placeVisible === false &&
    touchRaceLayout.exitVisible === false);
record(
  "ODbL帰属が変わらず見える",
  touchRaceLayout.attributionVisible === true &&
    touchRaceLayout.attributionText.includes("ODbL 1.0") &&
    touchRaceLayout.attributionText.includes("OpenStreetMap"),
);

await tapBuildButton("enter");
await wait(400);
const touchBuild = await snapshot();
const touchBuildLayout = await touchLayout();
const touchBuildShot = await capture("10-タッチで作成モード");
record("タッチで作成モードへ入る", touchBuild.buildMode === true);
record(
  "作成時は設置・撤去・レースへを表示",
  touchBuildLayout.placeVisible === true &&
    touchBuildLayout.removeVisible === true &&
    touchBuildLayout.exitVisible === true &&
    touchBuildLayout.enterVisible === false,
);

const touchWalkStart = await snapshot();
const touchWalked = await walkAlongLap(105, touchInput);
record(
  "タッチで歩いて移動する",
  Math.hypot(
    touchWalked.walkerX - touchWalkStart.walkerX,
    touchWalked.walkerY - touchWalkStart.walkerY,
  ) > 20,
);
record("移動先は設置可能", touchWalked.placementValid === true);

await tapBuildButton("place");
await wait(400);
const touchPlaced = await snapshot();
const touchPlacedShot = await capture("11-タッチで設置");
record("タッチで設置できる", touchPlaced.padCount === 3);

await tapBuildButton("exit");
await wait(400);
const touchExited = await snapshot();
const touchExitShot = await capture("12-タッチでレースへ戻る");
record("タッチでレースモードへ戻る", touchExited.buildMode === false);
record("タッチ設置後もパッドが3枚", touchExited.padCount === 3);

const localRequests = requests.filter((url) => {
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
});
record("外部通信が発生しない", localRequests.length === requests.length);
record("実行時例外が発生しない", exceptions.length === 0);

const report = {
  画像: {
    レース開始: raceStart,
    作成モード開始: buildEnteredShot,
    設置1枚目: firstPlacedShot,
    設置2枚目: secondPlacedShot,
    設置拒否: rejectedShot,
    レース復帰: raceResumedShot,
    俯瞰のパッド: topDownShot,
    加速中: boostShot,
    完走: finishShot,
    再読込復元: reloadShot,
    タッチ作成モード: touchBuildShot,
    タッチ設置: touchPlacedShot,
    タッチ復帰: touchExitShot,
  },
  タッチ配置: { レース: touchRaceLayout, 作成: touchBuildLayout },
  拒否メッセージ: rejected.messageText,
  保存内容: reloaded.storedPads,
  走行結果: {
    入力更新回数: driveTicks,
    完走状態: drive.kind,
    通過ゲート数: drive.checkpoints,
    パッド踏破回数: drive.boostHits,
    基準最高速度ms: STREET_MAX_SPEED,
    加速時の上限ms: drive.boostedMaxSpeed,
    観測最高速度ms: Number(peakSpeed.toFixed(3)),
    加速中の最高速度ms: Number(peakBoostedSpeed.toFixed(3)),
  },
  通信件数: requests.length,
  ローカル通信件数: localRequests.length,
  実行時例外: exceptions,
  検査: checks,
};
console.log(JSON.stringify(report, null, 2));

await releaseKeys();
client.close();

if (Object.values(checks).some((value) => value !== true)) {
  process.exitCode = 1;
  console.error("作成モードの検証に失敗しました。");
} else {
  console.log("作成モードの検証に成功しました。");
}
