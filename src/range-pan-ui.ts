/**
 * 範囲地図のDOM側。map-pan.ts の純計算だけを使って、タイルを並べ、
 * 指の動きを bbox の平行移動に直します。
 * 何を地図に重ねるか（経由点の印）と、印をタップした時に何が起きるかは知りません。
 */
import { RangePreparationError, validateBbox } from "./free-range.ts";
import type { Bbox } from "./fixture.ts";
import {
  panBbox,
  pointToViewportPixels,
  tileMosaic,
  type MapViewport,
  type PixelPoint,
} from "./map-pan.ts";

export const ZOOM = 16;
/** これ以下の動きは「タップ」、これを超えたら「パン」と見なします。 */
export const TAP_THRESHOLD_PX = 6;

/** 地図に重ねる印のHTML。座標は緯度経度から表示画素へ直して使います。 */
export type MapOverlay = (
  at: (latitude: number, longitude: number) => PixelPoint,
  viewport: MapViewport,
) => string;

export type RangePanPorts = Readonly<{
  map: HTMLElement;
  readBbox: () => Bbox;
  writeBbox: (bbox: Bbox) => void;
  showError: (message: string, code?: string) => void;
  /** パンで bbox が動いた後の面積表示の更新。 */
  onBboxChanged: () => void;
  /** 地図に重ねる印。 */
  overlay: MapOverlay;
  /** 描き直した直後に呼ばれます（印の番号付けなど）。 */
  onRendered: () => void;
  /** 動かさずに離した指が印の上だった時に呼ばれます。 */
  onTap: (marker: HTMLElement) => void;
  /** タップとして拾う印の選び方。 */
  tapSelector: string;
}>;

export type RangePan = Readonly<{
  /** 入力欄の bbox のとおりに描き直します。失敗は showError に出します。 */
  redraw: () => void;
}>;

export const setupRangePan = (ports: RangePanPorts): RangePan => {
  const { map } = ports;

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

  const renderBasemap = (): void => {
    const bbox = ports.readBbox();
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
    const markers = ports.overlay(at, viewport);
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
    ports.onRendered();
  };

  const redrawBasemap = (): void => {
    try {
      renderBasemap();
    } catch (reason) {
      ports.showError(
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

  map.addEventListener("pointerdown", (event) => {
    if (map.dataset.loaded !== "true") {
      return;
    }
    event.preventDefault();
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(ports.tapSelector)
        : null;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startBbox: ports.readBbox(),
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
    ports.writeBbox(moved);
    ports.onBboxChanged();
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
        ports.onTap(finished.marker);
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

  return { redraw: redrawBasemap };
};
