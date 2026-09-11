import "./style.css";
import {
  BOOST_DURATION_MS,
  BOOST_MULTIPLIER,
  boostedSpeedCap,
  evaluatePadPlacement,
  loadPads,
  removePadAt,
  savePads,
  type BoostPad,
} from "./boost-pads.ts";
import { stepWalker, type Walker } from "./build-mode.ts";
import {
  course as defaultCourse,
  courseFromFixture,
  type Course,
} from "./course.ts";
import {
  PREPARED_FIXTURE_KEY,
  type FixtureData,
} from "./fixture.ts";
import { setupRangePreparation } from "./range-ui.ts";
import { createRace, formatTime, stepRace, type DriveInput } from "./race.ts";
import { renderRace, type SceneOptions, type ViewMode } from "./render.ts";
import {
  DEFAULT_VEHICLE_ID,
  VEHICLES,
  vehicleById,
  type VehicleId,
} from "./vehicles.ts";

let course: Course = defaultCourse;
let activeFixtureName = "宮坂2丁目";
let usingPreparedFixture = false;
let storedFixtureError = "";
const storedFixture = localStorage.getItem(PREPARED_FIXTURE_KEY);
if (storedFixture) {
  try {
    const preparedFixture = JSON.parse(storedFixture) as FixtureData;
    course = courseFromFixture(preparedFixture);
    activeFixtureName = preparedFixture.place;
    usingPreparedFixture = true;
  } catch {
    storedFixtureError =
      "保存した範囲を読み込めません。再準備するかデモへ戻してください。";
  }
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("App root is absent.");
}

const vehicleOptions = VEHICLES.map(
  (vehicle, index) => `
    <button
      type="button"
      class="vehicle-option"
      data-vehicle-id="${vehicle.id}"
      aria-pressed="${vehicle.id === DEFAULT_VEHICLE_ID}"
    >
      <span><kbd>${index + 1}</kbd>${vehicle.name}</span>
      <strong>最高 ${Math.round(vehicle.maxSpeed * 3.6)} km/h</strong>
    </button>
  `,
).join("");

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <span id="area-label" class="eyebrow">${activeFixtureName}・1周</span>
        <h1>近所レース<span>（仮）</span></h1>
      </div>
      <div class="topbar-actions">
        <div class="data-mark">
          <span class="signal"></span>
          <span id="data-status">固定街区データ・通信なし</span>
        </div>
        <button id="build-toggle" class="range-open" type="button">
          コースを作る
        </button>
        <button id="open-range" class="range-open" type="button">
          範囲を準備
        </button>
      </div>
    </header>

    <section class="game-layout">
      <div class="stage-wrap">
        <canvas
          id="race-canvas"
          tabindex="0"
          aria-label="宮坂2丁目の街並みを走るレース画面"
        ></canvas>

        <div class="hud">
          <div class="hud-item timer-block">
            <span class="hud-label">タイム</span>
            <strong id="timer">00:00.00</strong>
          </div>
          <div class="hud-item">
            <span class="hud-label">速度</span>
            <strong><span id="speed">0</span><small> / <span id="speed-max">61</span> km/h</small></strong>
          </div>
          <div class="hud-item checkpoint-block">
            <span class="hud-label">通過</span>
            <strong><span id="checkpoints">0</span><small> / ${course.checkpointFractions.length}</small></strong>
          </div>
        </div>

        <div id="boost-badge" class="boost-badge" role="status" hidden>
          加速パッド ×${BOOST_MULTIPLIER.toFixed(1)}
          <small id="boost-remaining">0.0 s</small>
        </div>

        <div class="stage-status">
          <span id="status-dot"></span>
          <span id="status">発走前</span>
        </div>

        <div id="debug-badge" class="debug-badge" hidden>
          道路中心線 · ${course.roads.length}本
        </div>
        <div id="view-badge" class="view-badge">追従カメラ</div>

        <div id="ready-panel" class="state-panel ready-panel">
          <span class="panel-kicker">スタート地点</span>
          <h2>矢印キーで、走り出す。</h2>
          <p>黄色いラインを反時計回りに一周してください。</p>
          <div class="start-key"><kbd>↑</kbd><span>発走</span></div>
        </div>

        <div id="finish-panel" class="state-panel finish-panel" hidden>
          <span class="panel-kicker">1周完了</span>
          <h2>完走</h2>
          <strong id="finish-time">00:00.00</strong>
          <p><kbd>R</kbd> でもう一度</p>
        </div>

        <div id="offroad-alert" class="offroad-alert" hidden>
          <span id="road-alert">路肩です · 速度低下</span>
        </div>

        <div id="build-panel" class="build-panel" hidden>
          <div class="build-head">
            <span class="panel-kicker">コースを作る</span>
            <strong id="build-hint">路面の上で設置できます</strong>
          </div>
          <dl>
            <div><dt>↑ ↓ ← →</dt><dd>歩く</dd></div>
            <div><dt>E</dt><dd>加速パッドを置く</dd></div>
            <div><dt>X</dt><dd>足元のパッドを撤去</dd></div>
            <div><dt>B</dt><dd>レースへ戻る</dd></div>
          </dl>
          <p id="build-message" class="build-message" role="alert" hidden></p>
        </div>
      </div>

      <section id="touch-controls" class="touch-controls" aria-label="タッチ操作">
        <div class="touch-cluster" aria-label="ステア">
          <button type="button" data-touch-action="left" aria-label="左へ曲がる">
            <strong>←</strong><span>左</span>
          </button>
          <button type="button" data-touch-action="right" aria-label="右へ曲がる">
            <strong>→</strong><span>右</span>
          </button>
        </div>
        <div class="touch-cluster pedals" aria-label="速度操作">
          <button type="button" data-touch-action="brake" aria-label="ブレーキと後退">
            <strong>▼</strong><span>ブレーキ</span>
          </button>
          <button type="button" data-touch-action="accelerate" aria-label="アクセル">
            <strong>▲</strong><span>アクセル</span>
          </button>
        </div>
        <div class="touch-cluster build-cluster" aria-label="コース作り">
          <button type="button" data-build-action="enter" aria-label="コースを作る">
            <strong>✚</strong><span>つくる</span>
          </button>
          <button type="button" data-build-action="place" aria-label="加速パッドを置く">
            <strong>≫</strong><span>設置</span>
          </button>
          <button type="button" data-build-action="remove" aria-label="足元のパッドを撤去">
            <strong>✕</strong><span>撤去</span>
          </button>
          <button type="button" data-build-action="exit" aria-label="レースへ戻る">
            <strong>▶</strong><span>レースへ</span>
          </button>
        </div>
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          地図データ © OpenStreetMap の貢献者 · ODbL 1.0
        </a>
      </section>

      <aside class="side-panel">
        <section class="course-card">
          <div class="section-heading">
            <span>コース 01</span>
            <span><span id="course-distance">${Math.round(course.lapLength)}</span> m</span>
          </div>
          <h2 id="course-name">${activeFixtureName}</h2>
          <p id="course-description">実在する街路形状を固定データにした小さな周回です。</p>

          <div class="progress-heading">
            <span>周回進捗</span>
            <strong id="progress-label">0%</strong>
          </div>
          <div class="progress-track">
            <div id="progress-bar" class="progress-bar"></div>
          </div>
          <div class="progress-heading">
            <span>加速パッド</span>
            <strong><span id="pad-count">0</span> 個</strong>
          </div>
        </section>

        <section class="vehicle-card">
          <div class="section-heading">
            <span>車両選択</span>
            <span>切替で再発走</span>
          </div>
          <div class="vehicle-options">
            ${vehicleOptions}
          </div>
          <p id="vehicle-rule"></p>
        </section>

        <section class="controls-card">
          <div class="section-heading">
            <span>キー操作</span>
            <span>パソコン</span>
          </div>
          <div class="control-row">
            <div class="key-cluster">
              <kbd>↑</kbd>
              <div><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd></div>
            </div>
            <dl>
              <div><dt>↑ / W</dt><dd>アクセル</dd></div>
              <div><dt>↓ / S</dt><dd>ブレーキ・後退</dd></div>
              <div><dt>← → / A D</dt><dd>ステア</dd></div>
            </dl>
          </div>
          <div class="utility-keys">
            <span><kbd>R</kbd> やり直す</span>
            <span><kbd>G</kbd> 道路表示</span>
            <span><kbd>T</kbd> 俯瞰切替</span>
            <span><kbd>B</kbd> コース作り</span>
            <span><kbd>E</kbd> パッド設置</span>
            <span><kbd>X</kbd> パッド撤去</span>
          </div>
        </section>

        <section class="facts-card">
          <div>
            <span>道路幅</span>
            <strong>${course.roadWidth} m</strong>
          </div>
          <div>
            <span>境界範囲</span>
            <strong id="course-bbox">${course.bboxLabel}</strong>
          </div>
          <div>
            <span>建物</span>
            <strong><span id="building-count">${course.buildings.length}</span> 棟</strong>
          </div>
        </section>
      </aside>
    </section>

    <dialog id="range-dialog" class="range-dialog">
      <form method="dialog" class="range-panel">
        <div class="range-heading">
          <div>
            <span>自由範囲・1件</span>
            <h2>走る範囲を準備</h2>
          </div>
          <button type="submit" value="cancel" aria-label="閉じる">×</button>
        </div>
        <p class="range-notice">
          地図表示と「準備する」を押した時だけ通信します。準備後のレースは保存済みデータだけで動きます。
        </p>
        <div id="range-map" class="range-map" aria-label="範囲確認地図"></div>
        <div class="range-attribution">
          <span>選択範囲を青枠で表示</span>
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            © OpenStreetMap contributors · ODbL
          </a>
        </div>
        <div class="bbox-grid">
          <label>南<input id="bbox-south" type="number" step="0.0001" value="35.701"></label>
          <label>西<input id="bbox-west" type="number" step="0.0001" value="139.646"></label>
          <label>北<input id="bbox-north" type="number" step="0.0001" value="35.704"></label>
          <label>東<input id="bbox-east" type="number" step="0.0001" value="139.650"></label>
        </div>
        <p id="range-area" class="range-area"></p>
        <p id="range-error" class="range-error" role="alert" hidden></p>
        <div class="range-actions">
          <button id="refresh-map" type="button">地図を更新</button>
          <button id="use-demo" type="button">宮坂デモへ戻す</button>
          <button id="prepare-range" class="primary" type="button">準備する</button>
        </div>
      </form>
    </dialog>

    <footer>
      <span>地図タイルなし · 実行中の外部通信なし</span>
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
        地図データ © OpenStreetMap の貢献者 · ODbL 1.0
      </a>
    </footer>
  </main>
`;

const element = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) {
    throw new Error(`Required element ${selector} is absent.`);
  }
  return found;
};

const canvas = element<HTMLCanvasElement>("#race-canvas");
const timer = element<HTMLElement>("#timer");
const speed = element<HTMLElement>("#speed");
const speedMax = element<HTMLElement>("#speed-max");
const checkpoints = element<HTMLElement>("#checkpoints");
const progressLabel = element<HTMLElement>("#progress-label");
const progressBar = element<HTMLElement>("#progress-bar");
const status = element<HTMLElement>("#status");
const statusDot = element<HTMLElement>("#status-dot");
const readyPanel = element<HTMLElement>("#ready-panel");
const finishPanel = element<HTMLElement>("#finish-panel");
const finishTime = element<HTMLElement>("#finish-time");
const offroadAlert = element<HTMLElement>("#offroad-alert");
const roadAlert = element<HTMLElement>("#road-alert");
const debugBadge = element<HTMLElement>("#debug-badge");
const viewBadge = element<HTMLElement>("#view-badge");
const vehicleRule = element<HTMLElement>("#vehicle-rule");
const areaLabel = element<HTMLElement>("#area-label");
const dataStatus = element<HTMLElement>("#data-status");
const courseName = element<HTMLElement>("#course-name");
const courseDistance = element<HTMLElement>("#course-distance");
const courseBbox = element<HTMLElement>("#course-bbox");
const buildingCount = element<HTMLElement>("#building-count");
const vehicleButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-vehicle-id]"),
];
const touchControls = element<HTMLElement>("#touch-controls");
const touchButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-touch-action]"),
];
const buildButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-build-action]"),
];
const buildToggle = element<HTMLButtonElement>("#build-toggle");
const buildPanel = element<HTMLElement>("#build-panel");
const buildHint = element<HTMLElement>("#build-hint");
const buildMessage = element<HTMLElement>("#build-message");
const boostBadge = element<HTMLElement>("#boost-badge");
const boostRemaining = element<HTMLElement>("#boost-remaining");
const padCount = element<HTMLElement>("#pad-count");
const speedItem = speed.closest<HTMLElement>(".hud-item");

const heldKeys = new Set<string>();
type TouchAction = keyof DriveInput;
const touchPointers = new Map<number, TouchAction>();
let selectedVehicleId: VehicleId = DEFAULT_VEHICLE_ID;
let selectedVehicle = vehicleById(selectedVehicleId);
let race = createRace(course);
let debug = false;
let viewMode: ViewMode = "chase";
let previousTime = performance.now();
let mode: "race" | "build" = "race";
let pads: readonly BoostPad[] = [];
let walker: Walker = {
  position: race.vehicle.position,
  heading: race.vehicle.heading,
};
let placementValid = false;
let messageText = "";
let messageTone: "ok" | "error" = "ok";
let messageUntil = 0;

const MESSAGE_DURATION_MS = 3_200;

const showMessage = (text: string, tone: "ok" | "error"): void => {
  messageText = text;
  messageTone = tone;
  messageUntil = performance.now() + MESSAGE_DURATION_MS;
};

const updateTouchButtons = (): void => {
  const activeActions = new Set(touchPointers.values());
  for (const button of touchButtons) {
    button.classList.toggle(
      "pressed",
      activeActions.has(button.dataset.touchAction as TouchAction),
    );
  }
};

const clearTouchInput = (): void => {
  touchPointers.clear();
  updateTouchButtons();
};

const enterBuildMode = (): void => {
  mode = "build";
  walker = {
    position: race.vehicle.position,
    heading: race.vehicle.heading,
  };
  heldKeys.clear();
  clearTouchInput();
  showMessage(
    "路面の上まで歩いて、Eまたは設置ボタンで加速パッドを置きます。",
    "ok",
  );
};

const exitBuildMode = (): void => {
  mode = "race";
  race = createRace(course);
  heldKeys.clear();
  clearTouchInput();
  showMessage("", "ok");
};

const placePad = (): void => {
  const placement = evaluatePadPlacement(course, pads, walker.position);
  if (!placement.accepted) {
    showMessage(placement.message, "error");
    return;
  }
  pads = [...pads, placement.pad];
  savePads(course, pads, localStorage);
  showMessage(`加速パッドを置きました（${pads.length}個）。`, "ok");
};

const removePad = (): void => {
  const result = removePadAt(pads, walker.position);
  if (!result.removed) {
    showMessage("足元に加速パッドがありません。", "error");
    return;
  }
  pads = result.pads;
  savePads(course, pads, localStorage);
  showMessage(`加速パッドを撤去しました（${pads.length}個）。`, "ok");
};

const selectVehicle = (vehicleId: VehicleId): void => {
  selectedVehicleId = vehicleId;
  selectedVehicle = vehicleById(vehicleId);
  mode = "race";
  race = createRace(course);
  heldKeys.clear();
  clearTouchInput();
  speedMax.textContent = String(
    Math.round(selectedVehicle.maxSpeed * 3.6),
  );
  vehicleRule.textContent =
    selectedVehicleId === "street"
      ? "小道は通行不可 · 幹線道路は通行可"
      : "小道は通行可 · 幹線道路は通行不可";
  for (const button of vehicleButtons) {
    const selected = button.dataset.vehicleId === selectedVehicleId;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
};

const activateCourse = (
  nextCourse: Course,
  name: string,
  prepared: boolean,
): void => {
  course = nextCourse;
  activeFixtureName = name;
  usingPreparedFixture = prepared;
  race = createRace(course);
  pads = loadPads(course, localStorage);
  mode = "race";
  walker = {
    position: race.vehicle.position,
    heading: race.vehicle.heading,
  };
  heldKeys.clear();
  clearTouchInput();
  viewMode = "chase";
  areaLabel.textContent = `${activeFixtureName}・1周`;
  dataStatus.textContent = prepared
    ? "準備済み範囲・通信なし"
    : "固定街区データ・通信なし";
  courseName.textContent = activeFixtureName;
  courseDistance.textContent = String(Math.round(course.lapLength));
  courseBbox.textContent = course.bboxLabel;
  buildingCount.textContent = String(course.buildings.length);
};

const keyName = (event: KeyboardEvent): string => event.key.toLowerCase();
const drivingKeys = new Set([
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "w",
  "a",
  "s",
  "d",
]);

for (const button of vehicleButtons) {
  button.addEventListener("click", () => {
    const vehicleId = button.dataset.vehicleId;
    if (vehicleId === "street" || vehicleId === "alley") {
      selectVehicle(vehicleId);
    }
  });
}

const releaseTouchPointer = (event: PointerEvent): void => {
  if (touchPointers.delete(event.pointerId)) {
    event.preventDefault();
    updateTouchButtons();
  }
};

for (const button of touchButtons) {
  button.addEventListener("pointerdown", (event) => {
    const action = button.dataset.touchAction;
    if (
      action !== "accelerate" &&
      action !== "brake" &&
      action !== "left" &&
      action !== "right"
    ) {
      return;
    }
    event.preventDefault();
    touchPointers.set(event.pointerId, action);
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer tests do not create native pointer capture.
    }
    updateTouchButtons();
  });
  button.addEventListener("pointerup", releaseTouchPointer);
  button.addEventListener("pointercancel", releaseTouchPointer);
  button.addEventListener("lostpointercapture", releaseTouchPointer);
}

for (const button of buildButtons) {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    const action = button.dataset.buildAction;
    if (action === "enter") {
      enterBuildMode();
    } else if (action === "exit") {
      exitBuildMode();
    } else if (action === "place" && mode === "build") {
      placePad();
    } else if (action === "remove" && mode === "build") {
      removePad();
    }
  });
}

buildToggle.addEventListener("click", () => {
  if (mode === "build") {
    exitBuildMode();
  } else {
    enterBuildMode();
  }
});

touchControls.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});
touchControls.addEventListener(
  "touchmove",
  (event) => {
    event.preventDefault();
  },
  { passive: false },
);

window.addEventListener("keydown", (event) => {
  const key = keyName(event);
  if (drivingKeys.has(key)) {
    event.preventDefault();
    heldKeys.add(key);
  }
  if (event.repeat) {
    return;
  }
  if (key === "b") {
    if (mode === "build") {
      exitBuildMode();
    } else {
      enterBuildMode();
    }
  }
  if (key === "g") {
    debug = !debug;
  }
  if (key === "t") {
    viewMode = viewMode === "chase" ? "topDown" : "chase";
  }
  if (mode === "build") {
    if (key === "e") {
      placePad();
    }
    if (key === "x") {
      removePad();
    }
    return;
  }
  if (key === "r") {
    race = createRace(course);
  }
  if (key === "1") {
    selectVehicle("street");
  }
  if (key === "2") {
    selectVehicle("alley");
  }
});

window.addEventListener("keyup", (event) => {
  heldKeys.delete(keyName(event));
});

window.addEventListener("blur", () => {
  heldKeys.clear();
  clearTouchInput();
});

const readInput = (): DriveInput => {
  if (touchPointers.size > 0) {
    const activeActions = new Set(touchPointers.values());
    return {
      accelerate: activeActions.has("accelerate"),
      brake: activeActions.has("brake"),
      left: activeActions.has("left"),
      right: activeActions.has("right"),
    };
  }
  return {
    accelerate: heldKeys.has("arrowup") || heldKeys.has("w"),
    brake: heldKeys.has("arrowdown") || heldKeys.has("s"),
    left: heldKeys.has("arrowleft") || heldKeys.has("a"),
    right: heldKeys.has("arrowright") || heldKeys.has("d"),
  };
};

const updateInterface = (): void => {
  const building = mode === "build";
  const boosting = race.boostRemainingMs > 0;
  if (messageText && performance.now() > messageUntil) {
    messageText = "";
  }
  buildPanel.hidden = !building;
  buildToggle.textContent = building ? "レースへ戻る" : "コースを作る";
  buildToggle.classList.toggle("active", building);
  buildHint.textContent = building
    ? placementValid
      ? "ここに置けます"
      : "ここには置けません"
    : "路面の上で設置できます";
  buildHint.dataset.state = placementValid ? "valid" : "invalid";
  buildMessage.hidden = messageText === "";
  buildMessage.textContent = messageText;
  buildMessage.dataset.tone = messageTone;
  touchControls.dataset.mode = mode;
  padCount.textContent = String(pads.length);
  boostBadge.hidden = building || !boosting;
  boostRemaining.textContent = `${(race.boostRemainingMs / 1_000).toFixed(1)} s`;
  canvas.dataset.buildMode = String(building);
  canvas.dataset.padCount = String(pads.length);
  canvas.dataset.padIds = pads.map((pad) => pad.id).join(",");
  canvas.dataset.walkerX = walker.position.x.toFixed(4);
  canvas.dataset.walkerY = walker.position.y.toFixed(4);
  canvas.dataset.walkerHeading = walker.heading.toFixed(6);
  canvas.dataset.placementValid = String(placementValid);
  canvas.dataset.buildMessage = messageText;
  canvas.dataset.buildMessageTone = messageText ? messageTone : "";
  canvas.dataset.boostActive = String(boosting);
  canvas.dataset.boostRemainingMs = race.boostRemainingMs.toFixed(1);
  canvas.dataset.boostHits = String(race.boostHits);
  canvas.dataset.boostPadId = race.boostPadId ?? "";
  canvas.dataset.boostedMaxSpeed = boostedSpeedCap(selectedVehicleId).toFixed(4);
  canvas.dataset.boostDurationMs = String(BOOST_DURATION_MS);

  timer.textContent = formatTime(race.elapsedMs);
  speed.textContent = String(Math.round(Math.abs(race.vehicle.speed) * 3.6));
  checkpoints.textContent = String(race.checkpointsPassed);
  const displayProgress = race.kind === "finished" ? 1 : race.progress;
  progressLabel.textContent = `${Math.floor(displayProgress * 100)}%`;
  progressBar.style.width = `${Math.max(0, Math.min(1, displayProgress)) * 100}%`;
  readyPanel.hidden = building || race.kind !== "ready";
  finishPanel.hidden = building || race.kind !== "finished";
  offroadAlert.hidden =
    building || (race.onRoad && race.blockedForMs <= 0);
  speedItem?.classList.toggle("boosting", boosting);
  roadAlert.textContent =
    race.blockedForMs > 0
      ? "この道路は通行できません · 後退できます"
      : "路肩です · 速度低下";
  debugBadge.hidden = !debug;
  viewBadge.textContent =
    viewMode === "chase" ? "追従カメラ" : "俯瞰表示";
  canvas.dataset.raceKind = race.kind;
  canvas.dataset.vehicleX = race.vehicle.position.x.toFixed(4);
  canvas.dataset.vehicleY = race.vehicle.position.y.toFixed(4);
  canvas.dataset.vehicleHeading = race.vehicle.heading.toFixed(6);
  canvas.dataset.vehicleSpeed = race.vehicle.speed.toFixed(4);
  canvas.dataset.selectedVehicle = selectedVehicleId;
  canvas.dataset.vehicleMaxSpeed = selectedVehicle.maxSpeed.toFixed(4);
  canvas.dataset.blockedHits = String(race.blockedHits);
  canvas.dataset.blockedActive = String(race.blockedForMs > 0);
  canvas.dataset.blockedHighway = race.blockedHighway ?? "";
  canvas.dataset.inputSource =
    touchPointers.size > 0 ? "touch" : "keyboard";
  canvas.dataset.activeTouchCount = String(touchPointers.size);
  canvas.dataset.touchActions = [...new Set(touchPointers.values())]
    .sort()
    .join(",");
  canvas.dataset.viewMode = viewMode;

  if (building) {
    status.textContent = "コース作り";
    statusDot.dataset.state = "build";
  } else if (race.kind === "ready") {
    status.textContent = "発走前";
    statusDot.dataset.state = "ready";
  } else if (race.kind === "running") {
    status.textContent =
      race.blockedForMs > 0 ? "通行不可" : race.onRoad ? "走行中" : "路肩";
    statusDot.dataset.state =
      race.blockedForMs > 0
        ? "blocked"
        : race.onRoad
          ? "running"
          : "offroad";
  } else {
    status.textContent = "完走";
    statusDot.dataset.state = "finished";
    finishTime.textContent = formatTime(race.elapsedMs);
  }
};

const frame = (now: number): void => {
  const deltaSeconds = Math.min((now - previousTime) / 1_000, 0.1);
  previousTime = now;
  if (mode === "build") {
    walker = stepWalker(walker, readInput(), deltaSeconds, course);
    placementValid = evaluatePadPlacement(
      course,
      pads,
      walker.position,
    ).accepted;
  } else {
    race = stepRace(
      race,
      readInput(),
      deltaSeconds,
      course,
      selectedVehicleId,
      pads,
    );
  }
  const scene: SceneOptions = {
    pads,
    boostPadId: race.boostPadId,
    build:
      mode === "build"
        ? { walker, placementValid }
        : null,
  };
  updateInterface();
  const minimap = renderRace(
    canvas,
    course,
    race,
    debug,
    viewMode,
    selectedVehicle,
    scene,
  );
  canvas.dataset.minimapArrowX = minimap.arrowX.toFixed(3);
  canvas.dataset.minimapArrowY = minimap.arrowY.toFixed(3);
  canvas.dataset.minimapArrowHeading = minimap.arrowHeading.toFixed(6);
  requestAnimationFrame(frame);
};

setupRangePreparation({
  initialError: storedFixtureError,
  onPrepared: (fixture) => {
    activateCourse(
      courseFromFixture(fixture),
      fixture.place,
      true,
    );
  },
  onDemo: () => {
    activateCourse(defaultCourse, "宮坂2丁目", false);
  },
});
activateCourse(course, activeFixtureName, usingPreparedFixture);
selectVehicle(DEFAULT_VEHICLE_ID);
canvas.focus();
updateInterface();
requestAnimationFrame(frame);
