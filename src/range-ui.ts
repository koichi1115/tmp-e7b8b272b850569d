/**
 * 範囲ダイアログの組み立てだけを受け持ちます。
 * 入力欄は range-form.ts、地図と指の操作は range-pan-ui.ts、経由順は range-via-ui.ts、
 * 取得と生成は range-prepare.ts、保存の出し入れは range-record-ui.ts にあります。
 * ここは要素を探して、それらを繋ぐだけです。
 */
import type { FixtureData } from "./fixture.ts";
import type { PreparedRecord } from "./prepared-record.ts";
import { createRangeForm } from "./range-form.ts";
import { setupRangePan } from "./range-pan-ui.ts";
import { setupRangePrepare } from "./range-prepare.ts";
import { setupRangeRecordUi } from "./range-record-ui.ts";
import { VIA_MARKER_SELECTOR, setupViaOrder } from "./range-via-ui.ts";

type SetupOptions = Readonly<{
  initialError: string;
  restored: PreparedRecord | null;
  onPrepared: (fixture: FixtureData) => void;
  onDemo: () => void;
}>;

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
  const prepareButton = element<HTMLButtonElement>("#prepare-range");
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

  const form = createRangeForm({ dialog, error, area, inputs });

  const via = setupViaOrder({
    map,
    panel: viaPanel,
    list: viaList,
    status: viaStatus,
    undo: viaUndo,
    clear: viaClear,
    confirm: viaConfirm,
    showError: form.showError,
    onConfirm: (graph, viaNodeIds) => prepare.confirmVia(graph, viaNodeIds),
  });

  const pan = setupRangePan({
    map,
    readBbox: form.readBbox,
    writeBbox: form.writeBbox,
    showError: form.showError,
    onBboxChanged: form.updateArea,
    overlay: via.markers,
    onRendered: via.refresh,
    onTap: via.tap,
    tapSelector: VIA_MARKER_SELECTOR,
  });

  const record = setupRangeRecordUi({
    dialog,
    useDemo,
    clearRecord,
    restored: options.restored,
    initialError: options.initialError,
    writeBbox: form.writeBbox,
    showError: form.showError,
    onForget: () => {
      prepare.forget();
      via.forget();
    },
    onRestore: (stored) => {
      prepare.adoptFixture(stored.fixture);
      via.adopt(
        stored.fixture.roads,
        stored.fixture.bbox,
        stored.viaNodeIds,
      );
    },
    refreshVia: via.refresh,
    onPrepared: options.onPrepared,
    onDemo: options.onDemo,
  });

  const prepare = setupRangePrepare({
    dialog,
    prepareButton,
    autoConfirm,
    readBbox: form.readBbox,
    showError: form.showError,
    onRoadsReady: (roads, bbox) => via.adopt(roads, bbox, []),
    redraw: pan.redraw,
    save: record.save,
  });

  for (const input of Object.values(inputs)) {
    input.addEventListener("input", () => {
      form.updateArea();
      map.dataset.panned = "false";
    });
    input.addEventListener("change", () => {
      // 手入力も地図の中心をやり直します。bbox が唯一の出どころです。
      pan.redraw();
    });
  }

  openButton.addEventListener("click", () => {
    form.showError("");
    form.updateArea();
    dialog.showModal();
    pan.redraw();
  });

  refreshMap.addEventListener("click", () => {
    form.showError("");
    form.updateArea();
    pan.redraw();
  });

  record.restore();
  via.refresh();
  form.updateArea();
  record.showInitialError();
};
