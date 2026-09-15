import { mkdir, readFile, writeFile } from "node:fs/promises";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:43177/";
const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const OUTPUT_DIR = process.env.PROOF_DIR ?? "/tmp/kinjo-race-another-lap-proof";

const PREPARED_FIXTURE_KEY = "kinjo-race:prepared-fixture:v1";
const BOOST_PADS_KEY = "kinjo-race:boost-pads:v1";
const MARKER = `another-lap-${Date.now()}`;
const HELD_POINTER_ID = 101;

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

const checks = {};
const record = (name, value) => {
  checks[name] = value === true;
  console.log(`${value === true ? "合格" : "不合格"}: ${name}`);
  return value;
};

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
console.log(`PROOF_DIR: ${OUTPUT_DIR}`);

const requests = [];
const exceptions = [];
let navigations = 0;
client.on("Network.requestWillBeSent", ({ request }) => {
  requests.push(request.url);
});
client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
  exceptions.push(
    exceptionDetails.exception?.description ?? exceptionDetails.text,
  );
});
client.on("Page.frameNavigated", ({ frame }) => {
  if (!frame.parentId) {
    navigations += 1;
  }
});
await client.send("Network.enable");
await client.send("Runtime.enable");
await client.send("Page.enable");

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
await evaluate(
  `(() => {
    localStorage.removeItem("${PREPARED_FIXTURE_KEY}");
    localStorage.removeItem("${BOOST_PADS_KEY}");
  })()`,
);
await client.send("Page.navigate", { url: APP_URL });
await wait(1_400);
console.log("スマートフォン幅で宮坂デモを読み込みました。");

const capture = async (name) => {
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await mkdir(OUTPUT_DIR, { recursive: true });
  const path = `${OUTPUT_DIR}/${name}.png`;
  await writeFile(path, Buffer.from(screenshot.data, "base64"));
  console.log(`${path} を保存しました。`);
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

const nearestProgress = (position) => {
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
    const distance = Math.hypot(
      position.x - (first.x + dx * amount),
      position.y - (first.y + dy * amount),
    );
    if (distance < best.distance) {
      best = {
        distance,
        progressDistance:
          cumulative[index - 1] + Math.sqrt(squaredLength) * amount,
      };
    }
  }
  return best.progressDistance;
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
    const finishPanel = document.querySelector("#finish-panel");
    const readyPanel = document.querySelector("#ready-panel");
    const button = document.querySelector("#another-lap");
    const rect = button?.getBoundingClientRect();
    const hit = rect && rect.width > 0
      ? document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        )
      : null;
    return {
      kind: data?.raceKind,
      elapsedMs: Number(data?.elapsedMs),
      timerText: document.querySelector("#timer")?.textContent,
      restartCount: Number(data?.restartCount),
      fixtureName: data?.fixtureName,
      preparedFixture: data?.preparedFixture,
      courseName: document.querySelector("#course-name")?.textContent,
      selectedVehicle: data?.selectedVehicle,
      buildMode: data?.buildMode === "true",
      padCount: Number(data?.padCount),
      padIds: data?.padIds ?? "",
      walkerX: Number(data?.walkerX),
      walkerY: Number(data?.walkerY),
      walkerHeading: Number(data?.walkerHeading),
      placementValid: data?.placementValid === "true",
      x: Number(data?.vehicleX),
      y: Number(data?.vehicleY),
      heading: Number(data?.vehicleHeading),
      speed: Number(data?.vehicleSpeed),
      boostHits: Number(data?.boostHits),
      checkpoints: Number(
        document.querySelector("#checkpoints")?.textContent
      ),
      activeTouchCount: Number(data?.activeTouchCount),
      touchActions: data?.touchActions ?? "",
      pressedButtons: document.querySelectorAll(
        "[data-touch-action].pressed"
      ).length,
      finishVisible: finishPanel !== null && finishPanel.hidden === false,
      readyVisible: readyPanel !== null && readyPanel.hidden === false,
      buttonLabel: button?.textContent?.trim() ?? "",
      buttonType: button?.getAttribute("type") ?? "",
      buttonInFinishPanel: button?.parentElement === finishPanel,
      buttonRect: rect
        ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        : null,
      buttonHitTest: hit === button || button?.contains(hit) === true,
      keyHintVisible: finishPanel?.querySelector("kbd")?.textContent === "R",
      storedPads: localStorage.getItem("${BOOST_PADS_KEY}"),
      storedFixture: localStorage.getItem("${PREPARED_FIXTURE_KEY}"),
      marker: window.__kinjoAnotherLapMarker ?? null,
      viewportWidth: window.innerWidth
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

const releaseTouch = async () => {
  for (const action of ["accelerate", "brake", "left", "right"]) {
    await setTouchAction(action, false);
  }
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

const walkToPoint = async (targetPoint, tolerance = 1.2, limit = 500) => {
  let state = await snapshot();
  for (let tick = 0; tick < limit; tick += 1) {
    const gap = Math.hypot(
      targetPoint.x - state.walkerX,
      targetPoint.y - state.walkerY,
    );
    if (gap <= tolerance) {
      break;
    }
    const targetHeading = Math.atan2(
      targetPoint.y - state.walkerY,
      targetPoint.x - state.walkerX,
    );
    const headingError = Math.atan2(
      Math.sin(targetHeading - state.walkerHeading),
      Math.cos(targetHeading - state.walkerHeading),
    );
    await setTouchAction("accelerate", Math.abs(headingError) < 0.6);
    await setTouchAction("left", headingError < -0.04);
    await setTouchAction("right", headingError > 0.04);
    await wait(140);
    state = await snapshot();
  }
  await releaseTouch();
  await wait(150);
  return snapshot();
};

const driveLapByTouch = async () => {
  const delays = [300, 400, 500, 350];
  let ticks = 0;
  let state = await snapshot();
  const held = new Map();
  const set = async (action, down) => {
    if ((held.get(action) ?? false) === down) {
      return;
    }
    held.set(action, down);
    await setTouchAction(action, down);
  };
  while (state.kind !== "finished" && ticks < 420) {
    const position = { x: state.x, y: state.y };
    const targetPoint = pointAtDistance(nearestProgress(position) + 16);
    const targetHeading = Math.atan2(
      targetPoint.y - position.y,
      targetPoint.x - position.x,
    );
    const headingError = Math.atan2(
      Math.sin(targetHeading - state.heading),
      Math.cos(targetHeading - state.heading),
    );
    await set("accelerate", Math.abs(headingError) <= 1.05);
    await set("left", headingError < -0.05);
    await set("right", headingError > 0.05);
    await wait(delays[ticks % delays.length]);
    state = await snapshot();
    ticks += 1;
  }
  await releaseTouch();
  await wait(200);
  return { state: await snapshot(), ticks };
};

// Touch-only setup: place two boost pads through the touch build cluster.
const initial = await snapshot();
record("初期はレースモードでパッド0枚", !initial.buildMode && initial.padCount === 0);
record("初期コースは宮坂デモ", initial.fixtureName === "宮坂2丁目" && initial.preparedFixture === "false");
record(
  "完走パネルに「もう一周」ボタンがある",
  initial.buttonLabel === "もう一周" &&
    initial.buttonType === "button" &&
    initial.buttonInFinishPanel,
);
record("完走パネルにRキーの案内が残る", initial.keyHintVisible);
record("発走前は完走パネルが隠れている", !initial.finishVisible && initial.readyVisible);

await tapBuildButton("enter");
await wait(400);
const building = await snapshot();
record("タッチで作成モードへ入る", building.buildMode);
record("作成中は完走パネルもボタンも隠れている", !building.finishVisible && !building.buttonHitTest);

await walkToPoint(pointAtDistance(52));
await tapBuildButton("place");
await wait(350);
await walkToPoint(pointAtDistance(128));
await tapBuildButton("place");
await wait(350);
const placed = await snapshot();
record("タッチで加速パッドを2枚置ける", placed.padCount === 2);

await tapBuildButton("exit");
await wait(400);
await evaluate(`window.__kinjoAnotherLapMarker = "${MARKER}"`);
navigations = 0;
const base = await snapshot();
record("タッチでレースへ戻り発走前になる", !base.buildMode && base.kind === "ready");
const requestsBeforeLaps = requests.length;

// Lap 1 by touch only.
const lap1 = await driveLapByTouch();
const finish1 = lap1.state;
const finish1Shot = await capture("01-完走1回目");
record("1周目をタッチだけで完走する", finish1.kind === "finished");
record("1周目でゲートを4つ通過する", finish1.checkpoints === 4);
record("1周目で加速パッドを2回踏む", finish1.boostHits >= 2);
record("完走パネルが表示される", finish1.finishVisible && !finish1.readyVisible);
record(
  "「もう一周」の当たり判定が44px以上",
  finish1.viewportWidth <= 980 &&
    finish1.buttonRect !== null &&
    finish1.buttonRect.width >= 44 &&
    finish1.buttonRect.height >= 44,
);
record("「もう一周」の中心を指で押せる", finish1.buttonHitTest);

// Hold the accelerate finger across the tap to prove the restart clears it.
await setTouchAction("accelerate", true);
await wait(200);
const holding = await snapshot();
record(
  "完走後にアクセルの指を置いたまま",
  holding.kind === "finished" && holding.touchActions === "accelerate",
);

const rect = holding.buttonRect;
const tapPoint = {
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
  id: 7,
  radiusX: 4,
  radiusY: 4,
  force: 0.5,
};
await client.send("Input.dispatchTouchEvent", {
  type: "touchStart",
  touchPoints: [tapPoint],
});
await wait(80);
const midTap = await snapshot();
record(
  "ボタンを押す指はタッチ入力へ入らない",
  midTap.activeTouchCount === 1 &&
    midTap.touchActions === "accelerate" &&
    midTap.kind === "finished",
);
await client.send("Input.dispatchTouchEvent", {
  type: "touchEnd",
  touchPoints: [],
});
await wait(350);
const afterTap = await snapshot();
const afterTapShot = await capture("02-もう一周をタップ後");
record("タップで発走前へ戻る", afterTap.kind === "ready");
record(
  "タイマーが0へ戻る",
  afterTap.elapsedMs === 0 && afterTap.timerText === "00:00.00",
);
record(
  "スタート地点へ戻る",
  Math.hypot(afterTap.x - base.x, afterTap.y - base.y) < 1e-3 &&
    Math.abs(afterTap.heading - base.heading) < 1e-5 &&
    afterTap.speed === 0,
);
record("完走パネルが隠れ発走パネルが出る", !afterTap.finishVisible && afterTap.readyVisible);
record("再発走は共通関数を1回だけ通る", afterTap.restartCount === base.restartCount + 1);
record(
  "コースが変わらない",
  afterTap.fixtureName === base.fixtureName &&
    afterTap.preparedFixture === base.preparedFixture &&
    afterTap.courseName === base.courseName,
);
record("車両が変わらない", afterTap.selectedVehicle === base.selectedVehicle);
record(
  "パッドが変わらない",
  afterTap.padCount === 2 && afterTap.padIds === base.padIds,
);
record(
  "localStorageが変わらない",
  afterTap.storedPads === base.storedPads &&
    afterTap.storedFixture === base.storedFixture,
);
record(
  "タッチ入力が残らない",
  afterTap.activeTouchCount === 0 &&
    afterTap.touchActions === "" &&
    afterTap.pressedButtons === 0,
);
record("ページを再読み込みしていない", afterTap.marker === MARKER && navigations === 0);

await wait(1_000);
const idle = await snapshot();
record(
  "押しっぱなしの指で勝手に発走しない",
  idle.kind === "ready" && idle.speed === 0 && idle.elapsedMs === 0,
);
await setTouchAction("accelerate", false);
await wait(150);

// Lap 2 by touch only, on the same course and pads.
const lap2 = await driveLapByTouch();
const finish2 = lap2.state;
const finish2Shot = await capture("03-完走2回目");
record("2周目をタッチだけで完走する", finish2.kind === "finished");
record("2周目でゲートを4つ通過する", finish2.checkpoints === 4);
record("2周目も加速パッドが効く", finish2.boostHits >= 2);
record("2周目もパッドが同じ", finish2.padIds === base.padIds);
record("2周目の後もページを再読み込みしていない", finish2.marker === MARKER && navigations === 0);
record("2周目も完走パネルが表示される", finish2.finishVisible && finish2.buttonHitTest);

// Keyboard R goes through the same restart function.
await client.send("Input.dispatchKeyEvent", {
  type: "rawKeyDown",
  key: "r",
  code: "KeyR",
  windowsVirtualKeyCode: 82,
  nativeVirtualKeyCode: 82,
});
await client.send("Input.dispatchKeyEvent", {
  type: "keyUp",
  key: "r",
  code: "KeyR",
  windowsVirtualKeyCode: 82,
  nativeVirtualKeyCode: 82,
});
await wait(300);
const afterKey = await snapshot();
record(
  "Rキーも同じ共通関数で発走前へ戻る",
  afterKey.kind === "ready" &&
    afterKey.elapsedMs === 0 &&
    afterKey.restartCount === finish2.restartCount + 1 &&
    !afterKey.finishVisible,
);
record(
  "Rキー後もコース・車両・パッドが同じ",
  afterKey.fixtureName === base.fixtureName &&
    afterKey.selectedVehicle === base.selectedVehicle &&
    afterKey.padIds === base.padIds &&
    afterKey.storedPads === base.storedPads,
);

const lapRequests = requests.slice(requestsBeforeLaps);
const externalRequests = requests.filter((url) => {
  const parsed = new URL(url);
  return !(
    parsed.protocol === "data:" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost"
  );
});
record("周回中に通信が発生しない", lapRequests.length === 0);
record("外部通信が発生しない", externalRequests.length === 0);
record("実行時例外が発生しない", exceptions.length === 0);

await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
await client.send("Emulation.clearDeviceMetricsOverride");
client.close();

const report = {
  PROOF_DIR: OUTPUT_DIR,
  画像: {
    完走1回目: finish1Shot,
    もう一周タップ後: afterTapShot,
    完走2回目: finish2Shot,
  },
  ボタン矩形: finish1.buttonRect,
  周回: {
    "1周目": {
      入力更新回数: lap1.ticks,
      タイム: finish1.timerText,
      通過ゲート: finish1.checkpoints,
      パッド踏破: finish1.boostHits,
    },
    "2周目": {
      入力更新回数: lap2.ticks,
      タイム: finish2.timerText,
      通過ゲート: finish2.checkpoints,
      パッド踏破: finish2.boostHits,
    },
  },
  再発走回数: { 基準: base.restartCount, タップ後: afterTap.restartCount, R後: afterKey.restartCount },
  コース: afterKey.fixtureName,
  車両: afterKey.selectedVehicle,
  パッドID: afterKey.padIds,
  通信件数: requests.length,
  周回中の通信件数: lapRequests.length,
  外部通信: externalRequests,
  実行時例外: exceptions,
  検査: checks,
};
console.log(JSON.stringify(report, null, 2));

const failed = Object.entries(checks).filter(([, value]) => value !== true);
if (failed.length > 0) {
  process.exitCode = 1;
  console.error(
    `もう一周の検証に失敗しました（${failed.length}件）: ${failed
      .map(([name]) => name)
      .join(" / ")}`,
  );
} else {
  console.log(`もう一周の検証に成功しました（${Object.keys(checks).length}件）。`);
}
