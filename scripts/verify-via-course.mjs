/**
 * スライス11「経由指定＋範囲パン」の証明。外部通信は一切使いません。
 *
 *   段1（純関数）: 合成道路グラフから経由コースを作り、course.ts の規則を通し、
 *                  実際の race.ts で1周を完走させ、経由の順番どおりに進むことを確かめます。
 *   段2（実ブラウザ）: dist を127.0.0.1で配信し、外部URLを遮断したうえで
 *                  #range-map のドラッグが #bbox-* を書き換えること、交差点タップで
 *                  1・2・3の番号が付くこと、「経由でコース確定」で閉じた順序どおりの
 *                  周回路が保存されること、壊れた保存データが明示エラーになることを確かめます。
 *
 * 確かめられなかった時点で必ず非ゼロ終了します。
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { courseFromFixture, nextViaNumber } from "../src/course.ts";
import {
  parsePreparedRecord,
  serializePreparedRecord,
} from "../src/prepared-record.ts";
import {
  buildViaGraph,
  buildViaLap,
  intersectionNodes,
} from "../src/via-lap.ts";
import { panBbox } from "../src/map-pan.ts";
import { gridGraph, syntheticFixture } from "../tests/synthetic-grid.ts";
import { driveLap } from "./lap-simulation.mjs";

const OUTPUT_DIR = process.env.PROOF_DIR ?? "/tmp/kinjo-race-via-proof";
const APP_PORT = Number(process.env.VIA_APP_PORT ?? 43191);
/** 既に動いているブラウザの CDP 口。見つからなければ明示的に失敗します。 */
const CDP_CANDIDATES = [
  process.env.CDP_URL,
  "http://127.0.0.1:9222",
  "http://127.0.0.1:9223",
  "http://127.0.0.1:9224",
].filter(Boolean);
const DIST_DIR = resolve("dist");
const PREPARED_FIXTURE_KEY = "kinjo-race:prepared-fixture:v1";
const ZOOM = 16;

const checks = [];
const record = (name, passed, detail = "") => {
  const ok = passed === true;
  checks.push({ name, ok, detail });
  console.log(`${ok ? "合格" : "不合格"}: ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
};
const fail = (name, detail) => record(name, false, detail);
const wait = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));
const trace = (message) => {
  if (process.env.VIA_TRACE === "1") {
    console.log(`… ${message}`);
  }
};

// ------------------------------------------------------------ 合成コース
const grid = gridGraph(4, 4, 150);
const graph = buildViaGraph(grid.roads, grid.bbox);
const restoredVias = [grid.nodeId(1, 1), grid.nodeId(1, 2)];
const tappedVias = [
  grid.nodeId(1, 1),
  grid.nodeId(1, 2),
  grid.nodeId(2, 2),
];
const restoredLap = buildViaLap(graph, restoredVias);
const restoredFixture = syntheticFixture(grid.roads, grid.bbox, {
  roadWidthMeters: 14,
  checkpointFractions: restoredLap.checkpointFractions,
  lapLengthMeters: restoredLap.lapLengthMeters,
  lapNodeIds: restoredLap.lapNodeIds,
  viaNodeIds: restoredLap.viaNodeIds,
});
const storedRecord = serializePreparedRecord({
  bbox: grid.bbox,
  viaNodeIds: restoredVias,
  fixture: restoredFixture,
});

// ------------------------------------------------------------ 段1: 純関数
console.log("\n=== 段1: 経由コースの生成と完走（通信なし） ===");
const lap = buildViaLap(graph, tappedVias);
record(
  "経由コースが閉じている",
  lap.lapNodeIds[0] === lap.lapNodeIds.at(-1) &&
    lap.lapNodeIds[0] === tappedVias[0],
  `節点 ${lap.lapNodeIds.length} 個・${lap.lapLengthMeters} m`,
);
let searchFrom = 0;
let orderKept = true;
for (const via of tappedVias) {
  const index = lap.lapNodeIds.indexOf(via, searchFrom);
  if (index < searchFrom) {
    orderKept = false;
    break;
  }
  searchFrom = index + 1;
}
record("経由点が指定どおりの順に並ぶ", orderKept, lap.lapNodeIds.join("→"));
record(
  "交差点だけが経由候補になる",
  intersectionNodes(graph).length === 12 &&
    intersectionNodes(graph).every((node) => node.degree >= 3),
  `候補 ${intersectionNodes(graph).length} 点`,
);

const viaCourse = courseFromFixture(
  syntheticFixture(grid.roads, grid.bbox, {
    roadWidthMeters: 14,
    checkpointFractions: lap.checkpointFractions,
    lapLengthMeters: lap.lapLengthMeters,
    lapNodeIds: lap.lapNodeIds,
    viaNodeIds: lap.viaNodeIds,
  }),
);
record(
  "course.ts が経由コースを受け入れる",
  viaCourse.viaPoints.length === tappedVias.length &&
    viaCourse.checkpointFractions.length === tappedVias.length - 1,
  `経由 ${viaCourse.viaPoints.length} 点・通過 ${viaCourse.checkpointFractions.length} 点`,
);
record(
  "HUDの「次の経由」が順番どおりに進む",
  [0, 1, 2].map((passed) => nextViaNumber(viaCourse, passed)).join(",") ===
    "2,3,1",
  [0, 1, 2]
    .map((passed) => `次の経由: ${nextViaNumber(viaCourse, passed)} / 3`)
    .join(" → "),
);

const drive = driveLap(viaCourse, "street", [], { sample: true });
record(
  "経由コースを実際に1周して完走する",
  drive.finished === true,
  `${(drive.lapMs / 1_000).toFixed(2)} 秒・通過 ${drive.checkpointsPassed} 点`,
);
const observed = [];
for (const sample of drive.samples) {
  const number = nextViaNumber(viaCourse, sample.checkpointsPassed);
  if (observed.at(-1) !== number) {
    observed.push(number);
  }
}
record(
  "走行中の「次の経由」は 2 → 3 → 1 と変わる",
  observed.join(",") === "2,3,1",
  observed.map((number) => `${number}/3`).join(" → "),
);

// ------------------------------------------------------------ 配信と起動
const build = spawnSync(
  process.execPath,
  [resolve("node_modules/vite/bin/vite.js"), "build"],
  { stdio: "inherit" },
);
if (build.status !== 0) {
  fail("dist のビルド", `vite build が ${build.status} で終了しました。`);
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const server = createServer(async (request, response) => {
  const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
  const file = join(DIST_DIR, path === "/" ? "index.html" : path);
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
});
await new Promise((done, reject) => {
  server.once("error", reject);
  server.listen(APP_PORT, "127.0.0.1", done);
});
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
console.log(`\n=== 段2: 実ブラウザ（${APP_URL}） ===`);

let cdpUrl = "";
for (const candidate of CDP_CANDIDATES) {
  try {
    const version = await fetch(`${candidate}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (version.ok) {
      cdpUrl = candidate;
      break;
    }
  } catch {
    // 次の候補を試します。
  }
}
trace(`CDP: ${cdpUrl || "見つかりません"}`);

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
    await new Promise((done, reject) => {
      this.socket.addEventListener("open", done, { once: true });
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
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} が応答しません。`));
      }, Number(process.env.VIA_COMMAND_TIMEOUT_MS ?? 20_000));
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          done(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
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

let openedTarget = null;
const stop = async () => {
  if (openedTarget) {
    await fetch(`${cdpUrl}/json/close/${openedTarget}`).catch(() => {});
  }
  await new Promise((done) => server.close(done));
};

// 止まったまま緑にしないための番人。時間切れは必ず失敗です。
const watchdog = setTimeout(() => {
  console.error("時間切れ: 実ブラウザ検査が終わりませんでした。");
  process.exit(1);
}, Number(process.env.VIA_TIMEOUT_MS ?? 240_000));

let client = null;
try {
  let target = null;
  if (!cdpUrl) {
    fail(
      "ブラウザへ接続",
      `CDP が見つかりません（試した口: ${CDP_CANDIDATES.join(" ")}）。--remote-debugging-port 付きでブラウザを起動してください。`,
    );
  } else {
    const created = await fetch(`${cdpUrl}/json/new?about:blank`, {
      method: "PUT",
    });
    if (created.ok) {
      target = await created.json();
      openedTarget = target.id;
    }
  }
  trace(`ターゲット ${target?.id ?? "なし"}`);
  if (cdpUrl && !target?.webSocketDebuggerUrl) {
    fail("ブラウザへ接続", `CDP（${cdpUrl}）に page ターゲットがありません。`);
  } else if (target) {
    client = new ProtocolClient(target.webSocketDebuggerUrl);
    await client.open();
    trace("CDP接続");

    const overpassRequests = [];
    const externalResponses = [];
    const exceptions = [];
    const isLocal = (url) =>
      url.startsWith(APP_URL) || url.startsWith("data:") || url === "about:blank";
    client.on("Network.requestWillBeSent", ({ request }) => {
      if (/overpass|interpreter/i.test(request.url)) {
        overpassRequests.push(request.url);
      }
    });
    client.on("Network.responseReceived", ({ response }) => {
      if (!isLocal(response.url)) {
        externalResponses.push(`${response.url}（HTTP ${response.status}）`);
      }
    });
    client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      exceptions.push(
        exceptionDetails.exception?.description ?? exceptionDetails.text,
      );
    });
    await client.send("Network.enable");
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    // 外部への通信は最初から遮断します。試験は自分の配信だけで成り立ちます。
    await client.send("Network.setBlockedURLs", {
      urls: ["*openstreetmap.org*", "*overpass*", "*.tile.*"],
    });
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });

    const evaluate = async (expression) => {
      const result = await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      }
      return result.result.value;
    };

    const load = async (storedValue) => {
      trace("保存データを注入します");
      await client.send("Page.addScriptToEvaluateOnNewDocument", {
        source:
          storedValue === null
            ? `localStorage.removeItem(${JSON.stringify(PREPARED_FIXTURE_KEY)});`
            : `localStorage.setItem(${JSON.stringify(PREPARED_FIXTURE_KEY)}, ${JSON.stringify(storedValue)});`,
      });
      trace("注入完了・遷移します");
      await client.send("Page.navigate", { url: APP_URL });
      trace("遷移しました");
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await wait(150);
        if (await evaluate(`Boolean(document.querySelector("#race-canvas"))`)) {
          return true;
        }
      }
      return false;
    };

    const screenshot = async (name) => {
      const shot = await client.send("Page.captureScreenshot", {
        format: "png",
      });
      await writeFile(
        join(OUTPUT_DIR, name),
        Buffer.from(shot.data, "base64"),
      );
    };

    const rectOf = async (selector) =>
      evaluate(`(() => {
        const found = document.querySelector(${JSON.stringify(selector)});
        if (!found) { return null; }
        const box = found.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      })()`);

    const mouse = (type, x, y) =>
      client.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: type === "mouseReleased" ? 0 : 1,
        clickCount: 1,
      });

    const touchTap = async (x, y) => {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
      });
      await wait(40);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await wait(60);
    };

    await mkdir(OUTPUT_DIR, { recursive: true });
    trace("準備完了、読み込みへ");

    // ---------------------------------------------- 保存の復元と地図の表示
    record("保存済みの範囲でアプリが起動する", await load(storedRecord));
    const restoredState = await evaluate(`({
      fixture: document.querySelector("#race-canvas").dataset.fixtureName,
      viaCount: document.querySelector("#race-canvas").dataset.viaCount,
      lapLength: document.querySelector("#race-canvas").dataset.lapLength,
      south: document.querySelector("#bbox-south").value,
      west: document.querySelector("#bbox-west").value,
    })`);
    record(
      "保存した範囲と経由数が戻る",
      Number(restoredState.south).toFixed(6) ===
        grid.bbox.south.toFixed(6) &&
        Number(restoredState.west).toFixed(6) === grid.bbox.west.toFixed(6) &&
        restoredState.viaCount === "2",
      `南 ${restoredState.south} / 西 ${restoredState.west} / 経由 ${restoredState.viaCount}`,
    );

    await evaluate(`document.querySelector("#open-range").click()`);
    await wait(250);
    const restoredVia = await evaluate(`({
      markers: document.querySelectorAll("#range-map [data-via-node]").length,
      order: document.querySelector("#range-map").dataset.viaOrder,
      badges: [...document.querySelectorAll("#via-list li")].map((item) => item.textContent.trim()),
      panelHidden: document.querySelector("#via-panel").hidden,
    })`);
    record(
      "準備済みグラフの交差点が印として出る",
      restoredVia.markers === 12 && restoredVia.panelHidden === false,
      `印 ${restoredVia.markers} 個`,
    );
    record(
      "保存した経由順が番号付きで戻る",
      restoredVia.order === restoredVias.join(","),
      `${restoredVia.order} / ${restoredVia.badges.join(" ")}`,
    );

    // ---------------------------------------------- ドラッグで範囲を動かす
    const mapRect = await rectOf("#range-map");
    const before = await evaluate(`({
      south: Number(document.querySelector("#bbox-south").value),
      west: Number(document.querySelector("#bbox-west").value),
      north: Number(document.querySelector("#bbox-north").value),
      east: Number(document.querySelector("#bbox-east").value),
    })`);
    const dragDelta = { x: 96, y: -48 };
    const startX = mapRect.x + mapRect.width / 2;
    const startY = mapRect.y + mapRect.height / 2;
    await mouse("mousePressed", startX, startY);
    for (const step of [0.25, 0.5, 0.75, 1]) {
      await mouse(
        "mouseMoved",
        startX + dragDelta.x * step,
        startY + dragDelta.y * step,
      );
      await wait(30);
    }
    await mouse(
      "mouseReleased",
      startX + dragDelta.x,
      startY + dragDelta.y,
    );
    await wait(300);
    const after = await evaluate(`({
      south: Number(document.querySelector("#bbox-south").value),
      west: Number(document.querySelector("#bbox-west").value),
      north: Number(document.querySelector("#bbox-north").value),
      east: Number(document.querySelector("#bbox-east").value),
    })`);
    // 地図は指に付いて動くので、範囲は引いた向きの逆へ動きます。
    const expected = panBbox(
      before,
      { x: -dragDelta.x, y: -dragDelta.y },
      ZOOM,
    );
    const near = (left, right) => Math.abs(left - right) <= 2e-6;
    record(
      "ドラッグが #bbox-* を純関数どおりに書き換える",
      near(after.south, expected.south) &&
        near(after.west, expected.west) &&
        near(after.north, expected.north) &&
        near(after.east, expected.east),
      `南 ${after.south}（期待 ${expected.south.toFixed(6)}）・西 ${after.west}（期待 ${expected.west.toFixed(6)}）`,
    );
    record(
      "パンで範囲の大きさは変わらない",
      Math.abs(
        after.north - after.south - (before.north - before.south),
      ) < 1e-9 &&
        Math.abs(after.east - after.west - (before.east - before.west)) <
          1e-9,
      `南北 ${(after.north - after.south).toFixed(6)}°・東西 ${(after.east - after.west).toFixed(6)}°`,
    );

    // 手入力へ戻して、元の範囲で経由を選び直します。
    await evaluate(`(() => {
      const set = (id, value) => {
        const input = document.querySelector(id);
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      set("#bbox-south", ${grid.bbox.south});
      set("#bbox-west", ${grid.bbox.west});
      set("#bbox-north", ${grid.bbox.north});
      set("#bbox-east", ${grid.bbox.east});
    })()`);
    await wait(250);
    const restored = await evaluate(
      `Number(document.querySelector("#bbox-south").value)`,
    );
    record(
      "数値入力でも地図が中心へ戻る",
      Math.abs(restored - grid.bbox.south) < 1e-9,
      `南 ${restored}`,
    );

    // ---------------------------------------------- 経由点を順にタップする
    await evaluate(`document.querySelector("#via-clear").click()`);
    await wait(120);
    for (const nodeId of tappedVias) {
      const spot = await rectOf(`#range-map [data-via-node="${nodeId}"]`);
      if (!spot) {
        fail("交差点の印をタップ", `節点 ${nodeId} の印がありません。`);
        break;
      }
      await touchTap(spot.x + spot.width / 2, spot.y + spot.height / 2);
    }
    const tapped = await evaluate(`({
      order: document.querySelector("#range-map").dataset.viaOrder,
      badges: [...document.querySelectorAll("#range-map .via-marker.chosen")].map((marker) => marker.textContent.trim()),
      list: [...document.querySelectorAll("#via-list li span")].map((span) => span.textContent.trim()),
      confirmDisabled: document.querySelector("#via-confirm").disabled,
    })`);
    record(
      "タップした順に経由が積まれる",
      tapped.order === tappedVias.join(","),
      `${tapped.order}`,
    );
    record(
      "選んだ交差点に 1・2・3 の番号が付く",
      tapped.badges.sort().join(",") === "1,2,3" &&
        tapped.list.join(",") === "1,2,3",
      `印 ${tapped.badges.join("")} / 一覧 ${tapped.list.join("")}`,
    );
    record("2点以上で確定ボタンが押せる", tapped.confirmDisabled === false);
    await screenshot("range-pan-via.png");

    // ---------------------------------------------- 経由でコース確定
    const confirmRect = await rectOf("#via-confirm");
    await touchTap(
      confirmRect.x + confirmRect.width / 2,
      confirmRect.y + confirmRect.height / 2,
    );
    await wait(400);
    const confirmed = await evaluate(`({
      open: document.querySelector("#range-dialog").open,
      state: document.querySelector("#range-dialog").dataset.state,
      stored: localStorage.getItem(${JSON.stringify(PREPARED_FIXTURE_KEY)}),
      viaCount: document.querySelector("#race-canvas").dataset.viaCount,
      nextVia: document.querySelector("#race-canvas").dataset.nextVia,
      checkpointTotal: document.querySelector("#race-canvas").dataset.checkpointTotal,
      hudText: document.querySelector("#via-hud").dataset.text,
      hudHidden: document.querySelector("#via-hud").hidden,
      lapLength: document.querySelector("#race-canvas").dataset.lapLength,
      error: document.querySelector("#range-error").textContent,
    })`);
    record(
      "確定でダイアログが閉じ、経由コースへ入れ替わる",
      confirmed.open === false &&
        confirmed.state === "prepared" &&
        confirmed.viaCount === String(tappedVias.length),
      `状態 ${confirmed.state} / 経由 ${confirmed.viaCount} 点 / ${confirmed.lapLength} m`,
    );
    record(
      "HUDに「次の経由: 2 / 3」が出る",
      confirmed.hudHidden === false &&
        confirmed.hudText === `次の経由: 2 / ${tappedVias.length}`,
      confirmed.hudText,
    );
    record(
      "通過点の数は経由点の数より1つ少ない",
      confirmed.checkpointTotal === String(tappedVias.length - 1),
      `通過 ${confirmed.checkpointTotal} 点`,
    );

    const savedRecord = parsePreparedRecord(confirmed.stored);
    record(
      "保存記録に範囲と経由順が版付きで入る",
      savedRecord.recordVersion === 3 &&
        savedRecord.viaNodeIds.join(",") === tappedVias.join(","),
      `版 ${savedRecord.recordVersion} / 経由 ${savedRecord.viaNodeIds.join(",")}`,
    );
    const savedLap = savedRecord.fixture.course.lapNodeIds;
    let savedFrom = 0;
    let savedOrder = true;
    for (const via of tappedVias) {
      const index = savedLap.indexOf(via, savedFrom);
      if (index < savedFrom) {
        savedOrder = false;
        break;
      }
      savedFrom = index + 1;
    }
    record(
      "保存された周回路は閉じていて経由順どおり",
      savedLap[0] === savedLap.at(-1) &&
        savedLap[0] === tappedVias[0] &&
        savedOrder,
      savedLap.join("→"),
    );
    record(
      "保存された周回路を course.ts が受け入れる",
      courseFromFixture(savedRecord.fixture).viaPoints.length ===
        tappedVias.length,
    );
    await screenshot("race-hud-next-via.png");

    // ---------------------------------------------- 壊れた保存データ
    record("壊れた保存データでも起動する", await load("{壊れています"));
    const broken = await evaluate(`({
      open: document.querySelector("#range-dialog").open,
      message: document.querySelector("#range-error").textContent,
      code: document.querySelector("#range-error").dataset.code,
      hasClear: Boolean(document.querySelector("#clear-record")),
      fixture: document.querySelector("#race-canvas").dataset.fixtureName,
    })`);
    record(
      "壊れた保存データは黙って消えず、明示エラーになる",
      broken.open === true &&
        broken.message.includes("保存データを読めませんでした") &&
        broken.message.includes("parse") &&
        broken.hasClear === true,
      broken.message,
    );
    await screenshot("broken-record-error.png");

    record(
      "Overpass へは一度も問い合わせない",
      overpassRequests.length === 0,
      overpassRequests.slice(0, 2).join(" "),
    );
    record(
      "外部から読み込めたものは無い（タイルも遮断）",
      externalResponses.length === 0,
      externalResponses.slice(0, 3).join(" "),
    );
    record(
      "未捕捉の例外が無い",
      exceptions.length === 0,
      exceptions.slice(0, 2).join(" | "),
    );
  }
} catch (reason) {
  fail("実ブラウザ検査", reason instanceof Error ? reason.message : String(reason));
} finally {
  clearTimeout(watchdog);
  client?.close();
  await stop();
}

await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(
  join(OUTPUT_DIR, "via-verify.json"),
  `${JSON.stringify({ checks }, null, 2)}\n`,
);
const failed = checks.filter((check) => !check.ok);
console.log(
  `\n確認 ${checks.length} 件 / 不合格 ${failed.length} 件（証拠: ${OUTPUT_DIR}）`,
);
if (failed.length > 0) {
  for (const check of failed) {
    console.error(`不合格: ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  process.exit(1);
}
console.log("経由指定と範囲パンは、確かめたとおりに動きます。");
