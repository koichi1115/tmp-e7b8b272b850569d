/**
 * 経由点をタップした順に決めるUI。地図に置く印・順番の番号・一覧・
 * 「ひとつ戻す／クリア／経由でコース確定」の配線だけを持ちます。
 * 通信も保存もしません。経由順から周回路を作るのは via-lap.ts の仕事です。
 */
import type { Bbox, FixtureRoad } from "./fixture.ts";
import type { MapOverlay } from "./range-pan-ui.ts";
import { buildViaGraph, intersectionNodes, type ViaGraph } from "./via-lap.ts";

/** タップを拾う印の選び方。地図側にはこの文字列だけを渡します。 */
export const VIA_MARKER_SELECTOR = "[data-via-node]";

export const viaStatusText = (prepared: boolean, count: number): string =>
  prepared
    ? count === 0
      ? "地図の交差点を、通りたい順にタップしてください。"
      : `経由 ${count} 点。2点以上で「経由でコース確定」を押せます。`
    : "";

export const viaMarkerLabel = (nodeId: number, order: number): string =>
  order > 0 ? `交差点 ${nodeId}・経由 ${order} 番目` : `交差点 ${nodeId}`;

export type ViaOrderPorts = Readonly<{
  map: HTMLElement;
  panel: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  undo: HTMLButtonElement;
  clear: HTMLButtonElement;
  confirm: HTMLButtonElement;
  showError: (message: string, code?: string) => void;
  /** 「経由でコース確定」。いまのグラフと経由順をそのまま渡します。 */
  onConfirm: (graph: ViaGraph | null, viaNodeIds: readonly number[]) => void;
}>;

export type ViaOrderUi = Readonly<{
  /** 地図に重ねる交差点の印。 */
  markers: MapOverlay;
  /** 印・一覧・状態・ボタンの可否を、いまの経由順に合わせ直します。 */
  refresh: () => void;
  /** 準備できた道路から交差点グラフを作り、経由順を入れ替えます（DOMは触りません）。 */
  adopt: (
    roads: readonly FixtureRoad[],
    bbox: Bbox,
    viaNodeIds: readonly number[],
  ) => void;
  /** 準備前の状態へ戻します（DOMは触りません）。 */
  forget: () => void;
  /** 地図の印がタップされた時。 */
  tap: (marker: HTMLElement) => void;
}>;

export const setupViaOrder = (ports: ViaOrderPorts): ViaOrderUi => {
  const { map } = ports;

  let graph: ViaGraph | null = null;
  let viaNodeIds: number[] = [];

  const viaMarkers = (): HTMLElement[] => [
    ...map.querySelectorAll<HTMLElement>(VIA_MARKER_SELECTOR),
  ];

  const refresh = (): void => {
    const prepared = graph !== null;
    ports.panel.hidden = !prepared;
    ports.list.innerHTML = viaNodeIds
      .map(
        (nodeId, index) =>
          `<li data-via-node="${nodeId}"><span>${index + 1}</span>交差点 ${nodeId}</li>`,
      )
      .join("");
    ports.list.dataset.count = String(viaNodeIds.length);
    ports.status.textContent = viaStatusText(prepared, viaNodeIds.length);
    ports.undo.disabled = viaNodeIds.length === 0;
    ports.clear.disabled = viaNodeIds.length === 0;
    ports.confirm.disabled = viaNodeIds.length < 2;
    map.dataset.viaCount = String(viaNodeIds.length);
    map.dataset.viaOrder = viaNodeIds.join(",");
    for (const marker of viaMarkers()) {
      const nodeId = Number(marker.dataset.viaNode);
      const order = viaNodeIds.indexOf(nodeId) + 1;
      marker.dataset.viaOrder = order > 0 ? String(order) : "";
      marker.textContent = order > 0 ? String(order) : "";
      marker.classList.toggle("chosen", order > 0);
      marker.setAttribute("aria-label", viaMarkerLabel(nodeId, order));
    }
  };

  const markers: MapOverlay = (at, viewport) =>
    graph
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

  const appendVia = (nodeId: number): void => {
    if (!graph) {
      return;
    }
    if (viaNodeIds.at(-1) === nodeId) {
      ports.showError(
        "同じ交差点を続けて指定できません（duplicate_via）。",
        "duplicate_via",
      );
      return;
    }
    ports.showError("");
    viaNodeIds = [...viaNodeIds, nodeId];
    refresh();
  };

  ports.undo.addEventListener("click", () => {
    ports.showError("");
    viaNodeIds = viaNodeIds.slice(0, -1);
    refresh();
  });

  ports.clear.addEventListener("click", () => {
    ports.showError("");
    viaNodeIds = [];
    refresh();
  });

  ports.confirm.addEventListener("click", () => {
    ports.onConfirm(graph, viaNodeIds);
  });

  return {
    markers,
    refresh,
    adopt: (roads, bbox, order) => {
      graph = buildViaGraph(roads, bbox);
      viaNodeIds = [...order];
    },
    forget: () => {
      graph = null;
      viaNodeIds = [];
    },
    tap: (marker) => {
      appendVia(Number(marker.dataset.viaNode));
    },
  };
};
