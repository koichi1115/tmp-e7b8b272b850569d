/**
 * 公開URLで「遊べる最小」を fail-closed で確かめます。
 *
 *   --static  ビルド成果物のアセットが KINJO_BASE で始まり実在すること
 *   --remote  公開HTTPSが200で、アプリの土台とアセットが配信されていること
 *   --cdp     390x844のタッチだけで車両を選び、ゴールまで走れること
 *
 * どの段も、確かめられなかった時点で必ず非ゼロで終了します。
 * 「確認できなかった」を緑にはしません。
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const DIST_DIR = resolve(valueOf("--dist", process.env.KINJO_DIST ?? "dist"));
const BASE = valueOf("--base", process.env.KINJO_BASE ?? "/");
const PUBLIC_URL = valueOf("--url", process.env.PUBLIC_URL ?? "");
const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const OUTPUT_DIR = process.env.PROOF_DIR ?? "/tmp/kinjo-race-public-play-proof";

// 段の指定が無ければ全段を走らせます。
const runStatic = has("--static") || !(has("--remote") || has("--cdp"));
const runRemote = has("--remote") || !(has("--static") || has("--cdp"));
const runCdp = has("--cdp") || !(has("--static") || has("--remote"));

const checks = [];
const record = (name, passed, detail = "") => {
  const ok = passed === true;
  checks.push({ name, ok, detail });
  console.log(`${ok ? "合格" : "不合格"}: ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

/** 段そのものが実行できなかった場合。合格とは決して見なしません。 */
const notRun = (stage, reason) => {
  checks.push({ name: `${stage}（未実行）`, ok: false, detail: reason });
  console.error(`未実行: ${stage} — ${reason}`);
};

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/** index.html から自サイト向けのアセット参照を抜き出します。 */
const assetReferences = (html) => {
  const found = new Set();
  const pattern = /(?:src|href)\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const reference = match[1];
    if (/^(https?:|data:|mailto:|#)/.test(reference)) {
      continue;
    }
    found.add(reference);
  }
  return [...found];
};

// ---------------------------------------------------------------- 静的検査
const verifyStatic = async () => {
  console.log(`\n=== --static（${DIST_DIR}） ===`);
  if (!BASE.startsWith("/") || !BASE.endsWith("/")) {
    notRun("静的検査", `KINJO_BASE が "/" で始まり "/" で終わっていません: ${BASE}`);
    return;
  }
  const indexPath = join(DIST_DIR, "index.html");
  if (!(await exists(indexPath))) {
    notRun("静的検査", `${indexPath} がありません。先に build してください。`);
    return;
  }
  const html = await readFile(indexPath, "utf8");
  const references = assetReferences(html);

  record("index.html にアセット参照がある", references.length > 0, `${references.length} 件`);
  record(
    "アプリの土台 #app がある",
    html.includes('id="app"'),
  );
  record(
    "モジュールスクリプトが埋め込まれている",
    /<script[^>]+type="module"/.test(html),
  );

  for (const reference of references) {
    record(
      `アセットが KINJO_BASE 始まり: ${reference}`,
      reference.startsWith(BASE),
      `期待する接頭辞 ${BASE}`,
    );
    const relative = reference.slice(BASE.length).split(/[?#]/)[0];
    const filePath = join(DIST_DIR, relative);
    record(`アセットが実在する: ${relative}`, await exists(filePath), filePath);
  }

  // base が "/" 以外なら、素の絶対パスが残っていないことも確かめます。
  if (BASE !== "/") {
    record(
      "KINJO_BASE を通さない絶対パス参照が無い",
      references.every((reference) => reference.startsWith(BASE)),
    );
  }
};

// ---------------------------------------------------------------- 遠隔検査
const verifyRemote = async () => {
  console.log(`\n=== --remote（${PUBLIC_URL || "URL未指定"}） ===`);
  if (!PUBLIC_URL) {
    notRun("遠隔検査", "PUBLIC_URL（または --url）が指定されていません。");
    return;
  }
  let parsed;
  try {
    parsed = new URL(PUBLIC_URL);
  } catch {
    notRun("遠隔検査", `URL として読めません: ${PUBLIC_URL}`);
    return;
  }
  if (parsed.protocol !== "https:") {
    notRun("遠隔検査", `HTTPS ではありません: ${parsed.protocol}`);
    return;
  }

  let response;
  try {
    response = await fetch(PUBLIC_URL, { redirect: "follow" });
  } catch (error) {
    notRun("遠隔検査", `取得できません: ${error.message}`);
    return;
  }
  record("公開URLが200を返す", response.status === 200, `HTTP ${response.status}`);
  record(
    "HTMLとして配信されている",
    (response.headers.get("content-type") ?? "").includes("text/html"),
    response.headers.get("content-type") ?? "(content-type なし)",
  );
  const html = await response.text();
  record("アプリの土台 #app が配信される", html.includes('id="app"'));
  record(
    "モジュールスクリプトが配信される",
    /<script[^>]+type="module"/.test(html),
  );
  record("日本語のタイトルが配信される", html.includes("近所レース"));

  const references = assetReferences(html);
  record("配信HTMLにアセット参照がある", references.length > 0, `${references.length} 件`);
  for (const reference of references) {
    const assetUrl = new URL(reference, PUBLIC_URL).toString();
    let assetResponse;
    try {
      assetResponse = await fetch(assetUrl);
    } catch (error) {
      record(`アセットが200: ${reference}`, false, error.message);
      continue;
    }
    record(
      `アセットが200: ${reference}`,
      assetResponse.status === 200,
      `HTTP ${assetResponse.status} ${assetUrl}`,
    );
  }
};

// ---------------------------------------------------------------- 実機検査
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

/** 周回線の幾何。どこまで進んだかと、少し先の目標点を求めます。 */
const buildLapGeometry = async () => {
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

  return { nearestProgress, pointAtDistance };
};

const verifyCdp = async () => {
  console.log(`\n=== --cdp（${PUBLIC_URL || "URL未指定"}） ===`);
  if (!PUBLIC_URL) {
    notRun("実機検査", "PUBLIC_URL（または --url）が指定されていません。");
    return;
  }

  // 新しいタブを開きます。前の実行で指が残ったタブを使い回すと、
  // タッチが一切届かないまま「走れない」と誤判定するためです。
  let target;
  let openedTarget = null;
  try {
    const created = await fetch(`${CDP_URL}/json/new?about:blank`, {
      method: "PUT",
    });
    if (created.ok) {
      target = await created.json();
      openedTarget = target.id;
    } else {
      const targets = await fetch(`${CDP_URL}/json/list`).then((response) =>
        response.json(),
      );
      target = targets.find((candidate) => candidate.type === "page");
    }
  } catch (error) {
    notRun(
      "実機検査",
      `CDP（${CDP_URL}）へ接続できません: ${error.message}。ブラウザを --remote-debugging-port で起動してください。`,
    );
    return;
  }
  if (!target?.webSocketDebuggerUrl) {
    notRun("実機検査", `CDP（${CDP_URL}）に page ターゲットがありません。`);
    return;
  }
  const closeTarget = async () => {
    if (openedTarget) {
      await fetch(`${CDP_URL}/json/close/${openedTarget}`).catch(() => {});
    }
  };

  const client = new ProtocolClient(target.webSocketDebuggerUrl);
  await client.open();
  console.log("ブラウザへ接続しました。");
  console.log(`PROOF_DIR: ${OUTPUT_DIR}`);

  const exceptions = [];
  const failedRequests = [];
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    exceptions.push(
      exceptionDetails.exception?.description ?? exceptionDetails.text,
    );
  });
  client.on("Network.loadingFailed", ({ errorText, type }) => {
    failedRequests.push(`${type}: ${errorText}`);
  });
  await client.send("Network.enable");
  await client.send("Runtime.enable");
  await client.send("Page.enable");

  const evaluate = async (expression) => {
    const result = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
    }
    return result.result.value;
  };

  // スマートフォン幅・タッチのみ。
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

  await client.send("Page.navigate", { url: PUBLIC_URL });
  await wait(2_500);
  await evaluate(
    `(() => {
      localStorage.removeItem("kinjo-race:prepared-fixture:v1");
      localStorage.removeItem("kinjo-race:boost-pads:v1");
    })()`,
  );
  await client.send("Page.navigate", { url: PUBLIC_URL });
  await wait(2_500);

  const capture = async (name) => {
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await mkdir(OUTPUT_DIR, { recursive: true });
    const path = join(OUTPUT_DIR, `${name}.png`);
    await writeFile(path, Buffer.from(screenshot.data, "base64"));
    console.log(`${path} を保存しました。`);
    return path;
  };

  const snapshot = () =>
    evaluate(`(() => {
      const data = document.querySelector("#race-canvas")?.dataset;
      return {
        booted: document.querySelector("#race-canvas") !== null,
        kind: data?.raceKind,
        selectedVehicle: data?.selectedVehicle,
        x: Number(data?.vehicleX),
        y: Number(data?.vehicleY),
        heading: Number(data?.vehicleHeading),
        speed: Number(data?.vehicleSpeed),
        elapsedMs: Number(data?.elapsedMs),
        checkpoints: Number(document.querySelector("#checkpoints")?.textContent),
        timerText: document.querySelector("#timer")?.textContent,
        finishVisible:
          document.querySelector("#finish-panel")?.hidden === false,
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        touchActions: data?.touchActions ?? "",
        activeTouchCount: Number(data?.activeTouchCount),
        baseHref: [...document.querySelectorAll("script[type=module]")]
          .map((node) => node.getAttribute("src"))
          .join(",")
      };
    })()`);

  const boot = await snapshot();
  const bootShot = await capture("01-公開URLの初期表示");
  record("公開URLでアプリが起動する", boot.booted === true);
  record("スマートフォン幅で表示している", boot.viewportWidth === 390, `${boot.viewportWidth}px`);
  record(
    "横スクロールが出ない",
    boot.documentWidth <= boot.viewportWidth + 1,
    `document ${boot.documentWidth}px / viewport ${boot.viewportWidth}px`,
  );
  record("発走前の状態で始まる", boot.kind === "ready");
  record("既定の車両はまちぐるま", boot.selectedVehicle === "street");

  if (boot.booted !== true) {
    notRun("実機検査（タッチ操作）", "アプリが起動していないため操作へ進めません。");
    client.close();
    await closeTarget();
    return;
  }

  // 実機と同じ指の入力だけで操作します。
  const activeTouches = new Map();
  const touchPoints = () =>
    [...activeTouches.entries()].map(([id, point]) => ({
      x: point.x,
      y: point.y,
      id,
      radiusX: 6,
      radiusY: 6,
      force: 1,
    }));
  const touchDown = async (id, point) => {
    activeTouches.set(id, point);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: touchPoints(),
    });
  };
  // touchEnd の touchPoints は「離した指」を渡します（残っている指ではありません）。
  const touchUp = async (id) => {
    const point = activeTouches.get(id);
    if (!point) {
      return;
    }
    activeTouches.delete(id);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [
        { x: point.x, y: point.y, id, radiusX: 6, radiusY: 6, force: 1 },
      ],
    });
  };

  const rectOf = (selector) =>
    evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) { return null; }
      node.scrollIntoView({ block: "center" });
      const rect = node.getBoundingClientRect();
      const centre = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
      const hit = document.elementFromPoint(centre.x, centre.y);
      return {
        x: centre.x,
        y: centre.y,
        width: rect.width,
        height: rect.height,
        onScreen:
          centre.y >= 0 && centre.y <= window.innerHeight &&
          centre.x >= 0 && centre.x <= window.innerWidth,
        hittable: hit === node || node.contains(hit)
      };
    })()`);

  // --- タッチで車両を選ぶ（既定ではない「こみちぐるま」へ変える）
  const alleyRect = await rectOf('[data-vehicle-id="alley"]');
  record("車両ボタンが画面内にある", alleyRect !== null && alleyRect.onScreen === true);
  record(
    "車両ボタンの当たり判定が44px以上",
    alleyRect !== null && alleyRect.width >= 44 && alleyRect.height >= 44,
    alleyRect ? `${Math.round(alleyRect.width)}x${Math.round(alleyRect.height)}` : "なし",
  );
  record("車両ボタンを指で押せる", alleyRect !== null && alleyRect.hittable === true);

  if (alleyRect?.hittable) {
    await touchDown(1, alleyRect);
    await wait(90);
    await touchUp(1);
    await wait(400);
  }
  const afterSelect = await snapshot();
  const selectShot = await capture("02-タッチで車両を選んだ直後");
  record(
    "タッチで車両をこみちぐるまへ変えられる",
    afterSelect.selectedVehicle === "alley",
    `selectedVehicle=${afterSelect.selectedVehicle}`,
  );

  // --- タッチだけでゴールまで走る
  const { nearestProgress, pointAtDistance } = await buildLapGeometry();
  // 3つの座標は同じスクロール位置で一度に測ります。指を置く先がずれないようにするためです。
  const controlRects = await evaluate(`(() => {
    document.querySelector("#touch-controls")?.scrollIntoView({ block: "center" });
    const measure = (action) => {
      const node = document.querySelector('[data-touch-action="' + action + '"]');
      if (!node) { return null; }
      const rect = node.getBoundingClientRect();
      const centre = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
      const hit = document.elementFromPoint(centre.x, centre.y);
      return {
        x: centre.x,
        y: centre.y,
        width: rect.width,
        height: rect.height,
        hittable: hit === node || node.contains(hit)
      };
    };
    return {
      accelerate: measure("accelerate"),
      left: measure("left"),
      right: measure("right")
    };
  })()`);
  for (const action of ["accelerate", "left", "right"]) {
    record(
      `タッチ操作ボタンを指で押せる: ${action}`,
      controlRects[action] !== null && controlRects[action].hittable === true,
    );
    record(
      `タッチ操作ボタンの当たり判定が44px以上: ${action}`,
      controlRects[action] !== null &&
        controlRects[action].width >= 44 &&
        controlRects[action].height >= 44,
      controlRects[action]
        ? `${Math.round(controlRects[action].width)}x${Math.round(controlRects[action].height)}`
        : "なし",
    );
  }

  const fingerIds = { accelerate: 11, left: 12, right: 13 };
  const held = new Map();
  const setFinger = async (action, down) => {
    if ((held.get(action) ?? false) === down) {
      return;
    }
    held.set(action, down);
    if (down) {
      await touchDown(fingerIds[action], controlRects[action]);
    } else {
      await touchUp(fingerIds[action]);
    }
  };

  const delays = [300, 400, 500, 350];
  let state = await snapshot();
  let ticks = 0;
  try {
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
      await setFinger("accelerate", Math.abs(headingError) <= 1.05);
      await setFinger("left", headingError < -0.05);
      await setFinger("right", headingError > 0.05);
      await wait(delays[ticks % delays.length]);
      state = await snapshot();
      ticks += 1;
    }
  } finally {
    // 指を置いたまま終わるとブラウザのタッチ状態が残り、次の実行が必ず失敗します。
    for (const action of ["accelerate", "left", "right"]) {
      await setFinger(action, false).catch(() => {});
    }
  }
  await wait(250);

  const finish = await snapshot();
  const finishShot = await capture("03-タッチだけで完走");
  record("タッチだけでゴールまで走れる", finish.kind === "finished", `入力更新 ${ticks} 回`);
  record("ゲートを4つ通過する", finish.checkpoints === 4, `${finish.checkpoints} 個`);
  record("完走パネルが表示される", finish.finishVisible === true);
  record(
    "選んだ車両のまま完走する",
    finish.selectedVehicle === "alley",
    `selectedVehicle=${finish.selectedVehicle}`,
  );
  record("指を離すと入力が残らない", finish.activeTouchCount === 0 && finish.touchActions === "");
  record("実行時例外が発生しない", exceptions.length === 0, exceptions.join(" / "));
  record(
    "読み込みに失敗したリクエストが無い",
    failedRequests.length === 0,
    failedRequests.join(" / "),
  );

  await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await client.send("Emulation.clearDeviceMetricsOverride");
  client.close();
  await closeTarget();

  console.log(
    JSON.stringify(
      {
        URL: PUBLIC_URL,
        画像: { 初期表示: bootShot, 車両選択: selectShot, 完走: finishShot },
        完走タイム: finish.timerText,
        通過ゲート: finish.checkpoints,
        入力更新回数: ticks,
        実行時例外: exceptions,
        失敗リクエスト: failedRequests,
      },
      null,
      2,
    ),
  );
};

// ---------------------------------------------------------------- 実行
try {
  if (runStatic) {
    await verifyStatic();
  }
  if (runRemote) {
    await verifyRemote();
  }
  if (runCdp) {
    await verifyCdp();
  }
} catch (error) {
  notRun("公開スモーク", `途中で例外が起きました: ${error.stack ?? error.message}`);
}

const failed = checks.filter((check) => !check.ok);
console.log(`\n検査 ${checks.length} 件中 ${checks.length - failed.length} 件合格。`);
if (checks.length === 0) {
  console.error("検査が1件も走っていません。緑とは見なしません。");
  process.exit(1);
}
if (failed.length > 0) {
  console.error(
    `公開スモークに失敗しました（${failed.length}件）:\n${failed
      .map((check) => `  - ${check.name}${check.detail ? ` — ${check.detail}` : ""}`)
      .join("\n")}`,
  );
  process.exit(1);
}
console.log("公開スモークに成功しました。");
