import {
  DEFAULT_CHECKPOINT_FRACTIONS,
  MAX_BBOX_AREA_M2,
  OVERPASS_ENDPOINT,
  RangePreparationError,
  bboxSize,
  buildOverpassQuery,
  generateLap,
  prepareFixture,
  prepareRoads,
  validateBbox,
} from "./free-range.ts";
import {
  PREPARED_FIXTURE_KEY,
  type Bbox,
  type FixtureData,
  type FixtureRoad,
} from "./fixture.ts";
import {
  panBbox,
  pointToViewportPixels,
  tileMosaic,
} from "./map-pan.ts";
import {
  serializePreparedRecord,
  type PreparedRecord,
} from "./prepared-record.ts";
import {
  buildViaGraph,
  buildViaLap,
  intersectionNodes,
  withViaCourse,
  type ViaGraph,
} from "./via-lap.ts";

type SetupOptions = Readonly<{
  initialError: string;
  restored: PreparedRecord | null;
  onPrepared: (fixture: FixtureData) => void;
  onDemo: () => void;
}>;

/** 準備済みの道路。取得した応答か、保存から戻した fixture のどちらかです。 */
type Draft =
  | Readonly<{
      kind: "payload";
      bbox: Bbox;
      roads: readonly FixtureRoad[];
      payload: { elements?: readonly unknown[] };
      capturedAt: string;
      endpoint: string;
      query: string;
    }>
  | Readonly<{
      kind: "fixture";
      bbox: Bbox;
      roads: readonly FixtureRoad[];
      fixture: FixtureData;
    }>;

const ZOOM = 16;
/** これ以下の動きは「タップ」、これを超えたら「パン」と見なします。 */
const TAP_THRESHOLD_PX = 6;

const element = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) {
    throw new Error(`Required range element ${selector} is absent.`);
  }
  return found;
};

export const setupRangePreparation = (
  options: SetupOptions,
): void => {
  const dialog = element<HTMLDialogElement>("#range-dialog");
  const openButton = element<HTMLButtonElement>("#open-range");
  const map = element<HTMLElement>("#range-map");
  const area = element<HTMLElement>("#range-area");
  const error = element<HTMLElement>("#range-error");
  const refreshMap = element<HTMLButtonElement>("#refresh-map");
  const prepare = element<HTMLButtonElement>("#prepare-range");
  const useDemo = element<HTMLButtonElement>("#use-demo");
  const clearRecord = element<HTMLButtonElement>("#clear-record");
  const viaPanel = element<HTMLElement>("#via-panel");
  const viaList = element<HTMLElement>("#via-list");
  const viaStatus = element<HTMLElement>("#via-status");
  const viaUndo = element<HTMLButtonElement>("#via-undo");
  const viaClear = element<HTMLButtonElement>("#via-clear");
  const viaConfirm = element<HTMLButtonElement>("#via-confirm");
  const autoConfirm = element<HTMLButtonElement>("#auto-confirm");
  const inputs = {
    south: element<HTMLInputElement>("#bbox-south"),
    west: element<HTMLInputElement>("#bbox-west"),
    north: element<HTMLInputElement>("#bbox-north"),
    east: element<HTMLInputElement>("#bbox-east"),
  };

  let draft: Draft | null = null;
  let graph: ViaGraph | null = null;
  let viaNodeIds: number[] = [];
  let drag:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        startBbox: Bbox;
        marker: HTMLElement | null;
        moved: number;
      }
    | null = null;

  const readBbox = (): Bbox => ({
    south: Number(inputs.south.value),
    west: Number(inputs.west.value),
    north: Number(inputs.north.value),
    east: Number(inputs.east.value),
  });

  const writeBbox = (bbox: Bbox): void => {
    inputs.south.value = bbox.south.toFixed(6);
    inputs.west.value = bbox.west.toFixed(6);
    inputs.north.value = bbox.north.toFixed(6);
    inputs.east.value = bbox.east.toFixed(6);
  };

  const showError = (message: string, code = ""): void => {
    error.textContent = message;
    error.hidden = message.length === 0;
    error.dataset.code = message ? code : "";
    dialog.dataset.state = message ? "error" : "idle";
  };

  const updateArea = (): void => {
    const bbox = readBbox();
    try {
      const size = bboxSize(bbox);
      const areaKm2 = size.area / 1_000_000;
      area.textContent = `約 ${areaKm2.toFixed(3)} km² / 上限 ${(MAX_BBOX_AREA_M2 / 1_000_000).toFixed(2)} km²`;
      validateBbox(bbox);
      area.dataset.valid = "true";
    } catch (reason) {
      area.textContent =
        reason instanceof Error ? reason.message : "範囲を確認してください。";
      area.dataset.valid = "false";
    }
  };

  const viaMarkers = (): HTMLElement[] => [
    ...map.querySelectorAll<HTMLElement>("[data-via-node]"),
  ];

  const updateViaInterface = (): void => {
    const prepared = graph !== null;
    viaPanel.hidden = !prepared;
    viaList.innerHTML = viaNodeIds
      .map(
        (nodeId, index) =>
          `<li data-via-node="${nodeId}"><span>${index + 1}</span>交差点 ${nodeId}</li>`,
      )
      .join("");
    viaList.dataset.count = String(viaNodeIds.length);
    viaStatus.textContent = prepared
      ? viaNodeIds.length === 0
        ? "地図の交差点を、通りたい順にタップしてください。"
        : `経由 ${viaNodeIds.length} 点。2点以上で「経由でコース確定」を押せます。`
      : "";
    viaUndo.disabled = viaNodeIds.length === 0;
    viaClear.disabled = viaNodeIds.length === 0;
    viaConfirm.disabled = viaNodeIds.length < 2;
    map.dataset.viaCount = String(viaNodeIds.length);
    map.dataset.viaOrder = viaNodeIds.join(",");
    for (const marker of viaMarkers()) {
      const nodeId = Number(marker.dataset.viaNode);
      const order = viaNodeIds.indexOf(nodeId) + 1;
      marker.dataset.viaOrder = order > 0 ? String(order) : "";
      marker.textContent = order > 0 ? String(order) : "";
      marker.classList.toggle("chosen", order > 0);
      marker.setAttribute(
        "aria-label",
        order > 0
          ? `交差点 ${nodeId}・経由 ${order} 番目`
          : `交差点 ${nodeId}`,
      );
    }
  };

  const renderBasemap = (): void => {
    const bbox = readBbox();
    validateBbox(bbox);
    const rectangle = map.getBoundingClientRect();
    if (rectangle.width < 1 || rectangle.height < 1) {
      // まだ表示されていません。開いた時に描き直します。
      map.dataset.loaded = "false";
      return;
    }
    const viewport = {
      zoom: ZOOM,
      widthPx: rectangle.width,
      heightPx: rectangle.height,
    };
    const mosaic = tileMosaic(bbox, viewport);
    const at = (latitude: number, longitude: number) =>
      pointToViewportPixels(latitude, longitude, mosaic.originPx, ZOOM);
    const images = mosaic.tiles
      .map(
        (tile) =>
          `<img alt="" draggable="false" style="left:${tile.leftPx}px;top:${tile.topPx}px" src="https://tile.openstreetmap.org/${tile.zoom}/${tile.x}/${tile.y}.png">`,
      )
      .join("");
    const northWest = at(bbox.north, bbox.west);
    const southEast = at(bbox.south, bbox.east);
    const markers = graph
      ? intersectionNodes(graph)
          .map((node) => {
            const spot = at(node.latitude, node.longitude);
            if (
              spot.x < -20 ||
              spot.x > viewport.widthPx + 20 ||
              spot.y < -20 ||
              spot.y > viewport.heightPx + 20
            ) {
              return "";
            }
            return `<button type="button" class="via-marker" data-via-node="${node.nodeId}" style="left:${spot.x}px;top:${spot.y}px"></button>`;
          })
          .join("")
      : "";
    map.innerHTML = `
      <div class="range-scene">
        <div class="range-tiles">${images}</div>
        <div class="range-vias">${markers}</div>
      </div>
      <div
        class="range-box"
        style="left:${northWest.x}px;top:${northWest.y}px;width:${southEast.x - northWest.x}px;height:${southEast.y - northWest.y}px"
      ></div>
    `;
    map.dataset.loaded = "true";
    map.dataset.zoom = String(ZOOM);
    updateViaInterface();
  };

  const redrawBasemap = (): void => {
    try {
      renderBasemap();
    } catch (reason) {
      showError(
        reason instanceof Error ? reason.message : "地図を表示できません。",
        reason instanceof RangePreparationError ? reason.code : "",
      );
    }
  };

/** ドラッグ中は地図だけを指に付いて動かし、離した時に描き直します。 */
  const previewScene = (deltaX: number, deltaY: number): void => {
    const scene = map.querySelector<HTMLElement>(".range-scene");
    if (scene) {
      scene.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    }
  };

  const appendVia = (nodeId: number): void => {
    if (!graph) {
      return;
    }
    if (viaNodeIds.at(-1) === nodeId) {
      showError(
        "同じ交差点を続けて指定できません（duplicate_via）。",
        "duplicate_via",
      );
      return;
    }
    showError("");
    viaNodeIds = [...viaNodeIds, nodeId];
    updateViaInterface();
  };

  map.addEventListener("pointerdown", (event) => {
    if (map.dataset.loaded !== "true") {
      return;
    }
    event.preventDefault();
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-via-node]")
        : null;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startBbox: readBbox(),
      marker: target,
      moved: 0,
    };
    try {
      map.setPointerCapture(event.pointerId);
    } catch {
      // 合成ポインタの試験では実際の捕捉が起きません。
    }
  });

  map.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    drag.moved = Math.max(drag.moved, Math.hypot(deltaX, deltaY));
    if (drag.moved < TAP_THRESHOLD_PX) {
      return;
    }
    event.preventDefault();
    // 地図は指に付いて動き、範囲はその逆へ動きます（地図の上で枠を動かす感覚）。
    const moved = panBbox(
      drag.startBbox,
      { x: -deltaX, y: -deltaY },
      ZOOM,
    );
    writeBbox(moved);
    updateArea();
    previewScene(deltaX, deltaY);
    map.dataset.panned = "true";
  });

  const finishDrag = (event: PointerEvent): void => {
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const finished = drag;
    drag = null;
    try {
      map.releasePointerCapture(event.pointerId);
    } catch {
      // 捕捉していない場合は何もしません。
    }
    if (finished.moved < TAP_THRESHOLD_PX) {
      if (finished.marker) {
        appendVia(Number(finished.marker.dataset.viaNode));
      }
      return;
    }
    redrawBasemap();
  };

  map.addEventListener("pointerup", finishDrag);
  map.addEventListener("pointercancel", finishDrag);
  map.addEventListener("lostpointercapture", finishDrag);
  map.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  for (const input of Object.values(inputs)) {
    input.addEventListener("input", () => {
      updateArea();
      map.dataset.panned = "false";
    });
    input.addEventListener("change", () => {
      // 手入力も地図の中心をやり直します。bbox が唯一の出どころです。
      redrawBasemap();
    });
  }

  openButton.addEventListener("click", () => {
    showError("");
    updateArea();
    dialog.showModal();
    redrawBasemap();
  });

  refreshMap.addEventListener("click", () => {
    showError("");
    updateArea();
    redrawBasemap();
  });

  viaUndo.addEventListener("click", () => {
    showError("");
    viaNodeIds = viaNodeIds.slice(0, -1);
    updateViaInterface();
  });

  viaClear.addEventListener("click", () => {
    showError("");
    viaNodeIds = [];
    updateViaInterface();
  });

  clearRecord.addEventListener("click", () => {
    localStorage.removeItem(PREPARED_FIXTURE_KEY);
    draft = null;
    graph = null;
    viaNodeIds = [];
    showError("");
    updateViaInterface();
    options.onDemo();
    dialog.dataset.state = "cleared";
    dialog.close();
  });

  const saveAndActivate = (
    bbox: Bbox,
    fixture: FixtureData,
    vias: readonly number[],
  ): void => {
    localStorage.setItem(
      PREPARED_FIXTURE_KEY,
      serializePreparedRecord({ bbox, viaNodeIds: vias, fixture }),
    );
    options.onPrepared(fixture);
    dialog.dataset.state = "prepared";
    dialog.close();
  };

  const describe = (reason: unknown): void => {
    showError(
      reason instanceof Error
        ? reason.message
        : "範囲を準備できませんでした。",
      reason instanceof RangePreparationError
        ? reason.code
        : reason instanceof Error && "code" in reason
          ? String((reason as { code: unknown }).code)
          : "",
    );
  };

  viaConfirm.addEventListener("click", () => {
    showError("");
    if (!draft || !graph) {
      showError("先に範囲を準備してください。", "not_prepared");
      return;
    }
    try {
      const lap = buildViaLap(graph, viaNodeIds);
      const fixture =
        draft.kind === "payload"
          ? prepareFixture(
              draft.payload,
              draft.bbox,
              {
                place: "経由コース",
                capturedAt: draft.capturedAt,
                endpoint: draft.endpoint,
                query: draft.query,
              },
              { lap },
            )
          : withViaCourse(draft.fixture, lap);
      saveAndActivate(draft.bbox, fixture, lap.viaNodeIds);
    } catch (reason) {
      describe(reason);
    }
  });

  autoConfirm.addEventListener("click", () => {
    showError("");
    if (!draft) {
      showError("先に範囲を準備してください。", "not_prepared");
      return;
    }
    try {
      const fixture =
        draft.kind === "payload"
          ? prepareFixture(draft.payload, draft.bbox, {
              place: "準備した範囲",
              capturedAt: draft.capturedAt,
              endpoint: draft.endpoint,
              query: draft.query,
            })
          : {
              ...draft.fixture,
              course: {
                ...draft.fixture.course,
                checkpointFractions: DEFAULT_CHECKPOINT_FRACTIONS,
                ...generateLap(draft.roads, draft.bbox),
                viaNodeIds: [],
              },
            };
      saveAndActivate(draft.bbox, fixture, []);
    } catch (reason) {
      describe(reason);
    }
  });

  prepare.addEventListener("click", async () => {
    showError("");
    const bbox = readBbox();
    try {
      validateBbox(bbox);
      prepare.disabled = true;
      prepare.textContent = "取得・生成中…";
      dialog.dataset.state = "loading";
      const query = buildOverpassQuery(bbox);
      const endpoints = [
        OVERPASS_ENDPOINT,
        "https://overpass-api.de/api/interpreter",
      ];
      let response:
        | { endpoint: string; payload: unknown }
        | undefined;
      for (const endpoint of endpoints) {
        try {
          const result = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ data: query }),
            signal: AbortSignal.timeout(30_000),
          });
          if (result.ok) {
            response = {
              endpoint,
              payload: await result.json(),
            };
            break;
          }
        } catch {
          // The next ODbL-compatible endpoint is tried explicitly.
        }
      }
      if (!response) {
        throw new RangePreparationError(
          "response",
          "道路データを取得できませんでした。時間を置いて再試行してください。",
        );
      }
      const payload = response.payload as { elements?: readonly unknown[] };
      const roads = prepareRoads(payload, bbox);
      draft = {
        kind: "payload",
        bbox,
        roads,
        payload,
        capturedAt: new Date().toISOString(),
        endpoint: response.endpoint,
        query,
      };
      graph = buildViaGraph(roads, bbox);
      viaNodeIds = [];
      dialog.dataset.state = "graph";
      redrawBasemap();
    } catch (reason) {
      describe(reason);
    } finally {
      prepare.disabled = false;
      prepare.textContent = "準備する";
    }
  });

  useDemo.addEventListener("click", () => {
    localStorage.removeItem(PREPARED_FIXTURE_KEY);
    draft = null;
    graph = null;
    viaNodeIds = [];
    updateViaInterface();
    options.onDemo();
    dialog.close();
  });

  /** 保存済みの範囲と経由順を、通信なしでそのまま編集できる状態に戻します。 */
  if (options.restored) {
    const record = options.restored;
    writeBbox(record.bbox);
    draft = {
      kind: "fixture",
      bbox: record.fixture.bbox,
      roads: record.fixture.roads,
      fixture: record.fixture,
    };
    graph = buildViaGraph(record.fixture.roads, record.fixture.bbox);
    viaNodeIds = [...record.viaNodeIds];
  }

  updateViaInterface();
  updateArea();
  if (options.initialError) {
    queueMicrotask(() => {
      dialog.showModal();
      showError(options.initialError, "record");
    });
  }
};
