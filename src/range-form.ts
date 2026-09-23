/**
 * 範囲ダイアログの入力欄と表示面。bbox の読み書き・面積表示・エラー表示だけを持ち、
 * 通信も保存も地図描画も知りません。bbox の唯一の出どころはこの入力欄です。
 */
import { MAX_BBOX_AREA_M2, bboxSize, validateBbox } from "./free-range.ts";
import type { Bbox } from "./fixture.ts";

export type RangeInputs = Readonly<{
  south: HTMLInputElement;
  west: HTMLInputElement;
  north: HTMLInputElement;
  east: HTMLInputElement;
}>;

export type RangeFormParts = Readonly<{
  dialog: HTMLDialogElement;
  error: HTMLElement;
  area: HTMLElement;
  inputs: RangeInputs;
}>;

export type RangeForm = Readonly<{
  readBbox: () => Bbox;
  writeBbox: (bbox: Bbox) => void;
  showError: (message: string, code?: string) => void;
  updateArea: () => void;
}>;

export const createRangeForm = (parts: RangeFormParts): RangeForm => {
  const { dialog, error, area, inputs } = parts;

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

  return { readBbox, writeBbox, showError, updateArea };
};
