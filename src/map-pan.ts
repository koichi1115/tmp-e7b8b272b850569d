/**
 * 範囲地図のピクセル↔緯度経度換算。DOM も通信も持ちません。
 * ウェブメルカトル（OSM標準タイルと同じ）で、指の移動量を bbox の平行移動に直します。
 */
import type { Bbox } from "./fixture.ts";

export const TILE_SIZE = 256;

/** 緯度の可動域。ウェブメルカトルの実用上限と validateBbox に合わせます。 */
export const MAX_LATITUDE = 85;
export const MAX_LONGITUDE = 180;

export type PixelPoint = Readonly<{ x: number; y: number }>;

export type LatLon = Readonly<{ latitude: number; longitude: number }>;

export type MapViewport = Readonly<{
  zoom: number;
  widthPx: number;
  heightPx: number;
}>;

export type MosaicTile = Readonly<{
  zoom: number;
  x: number;
  y: number;
  leftPx: number;
  topPx: number;
}>;

export type Mosaic = Readonly<{
  tiles: readonly MosaicTile[];
  /** 表示領域の左上にあたる世界画素。地物の位置はここからの差で決まります。 */
  originPx: PixelPoint;
}>;

const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
};

export const worldSize = (zoom: number): number =>
  TILE_SIZE * 2 ** finite(zoom, "zoom");

export const projectToPixels = (
  latitude: number,
  longitude: number,
  zoom: number,
): PixelPoint => {
  const size = worldSize(zoom);
  const latitudeRadians =
    (finite(latitude, "latitude") * Math.PI) / 180;
  return {
    x: ((finite(longitude, "longitude") + 180) / 360) * size,
    y:
      ((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * size,
  };
};

export const unprojectFromPixels = (
  point: PixelPoint,
  zoom: number,
): LatLon => {
  const size = worldSize(zoom);
  const longitude = (finite(point.x, "x") / size) * 360 - 180;
  const latitude =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * finite(point.y, "y")) / size))) *
      180) /
    Math.PI;
  return { latitude, longitude };
};

export const bboxCenter = (bbox: Bbox): LatLon => ({
  latitude: (bbox.south + bbox.north) / 2,
  longitude: (bbox.west + bbox.east) / 2,
});

export const bboxSpan = (
  bbox: Bbox,
): Readonly<{ latitudeSpan: number; longitudeSpan: number }> => ({
  latitudeSpan: bbox.north - bbox.south,
  longitudeSpan: bbox.east - bbox.west,
});

/**
 * 範囲の中心を表示の中心に置いた、等倍のタイル並び。
 * 引き伸ばさないので、画素の差はそのまま地理の差になります。
 */
export const tileMosaic = (
  bbox: Bbox,
  viewport: MapViewport,
): Mosaic => {
  if (viewport.widthPx <= 0 || viewport.heightPx <= 0) {
    throw new Error("Map viewport must have a positive size.");
  }
  const center = bboxCenter(bbox);
  const centerPixels = projectToPixels(
    center.latitude,
    center.longitude,
    viewport.zoom,
  );
  const originPx = {
    x: centerPixels.x - viewport.widthPx / 2,
    y: centerPixels.y - viewport.heightPx / 2,
  };
  const tiles: MosaicTile[] = [];
  const firstX = Math.floor(originPx.x / TILE_SIZE);
  const lastX = Math.floor((originPx.x + viewport.widthPx) / TILE_SIZE);
  const firstY = Math.floor(originPx.y / TILE_SIZE);
  const lastY = Math.floor((originPx.y + viewport.heightPx) / TILE_SIZE);
  const span = 2 ** viewport.zoom;
  for (let y = firstY; y <= lastY; y += 1) {
    for (let x = firstX; x <= lastX; x += 1) {
      tiles.push({
        zoom: viewport.zoom,
        x: ((x % span) + span) % span,
        y: Math.min(Math.max(y, 0), span - 1),
        leftPx: x * TILE_SIZE - originPx.x,
        topPx: y * TILE_SIZE - originPx.y,
      });
    }
  }
  return { tiles, originPx };
};

/** 緯度経度を、表示領域の左上からの画素位置へ直します。 */
export const pointToViewportPixels = (
  latitude: number,
  longitude: number,
  originPx: PixelPoint,
  zoom: number,
): PixelPoint => {
  const pixels = projectToPixels(latitude, longitude, zoom);
  return {
    x: pixels.x - originPx.x,
    y: pixels.y - originPx.y,
  };
};

/**
 * bbox をタイル画素ぶんだけ平行移動します。南北・東西の幅は一切変えません。
 * 端に達したら幅を保ったまま止まります（縮めません）。
 */
export const panBbox = (
  bbox: Bbox,
  deltaTilePixels: PixelPoint,
  zoom: number,
): Bbox => {
  finite(deltaTilePixels.x, "delta.x");
  finite(deltaTilePixels.y, "delta.y");
  if (deltaTilePixels.x === 0 && deltaTilePixels.y === 0) {
    // 動かさないドラッグで座標が丸め誤差ぶん動かないようにします。
    return bbox;
  }
  const span = bboxSpan(bbox);
  const center = bboxCenter(bbox);
  const centerPixels = projectToPixels(
    center.latitude,
    center.longitude,
    zoom,
  );
  const moved = unprojectFromPixels(
    {
      x: centerPixels.x + finite(deltaTilePixels.x, "delta.x"),
      y: centerPixels.y + finite(deltaTilePixels.y, "delta.y"),
    },
    zoom,
  );
  let south = moved.latitude - span.latitudeSpan / 2;
  let north = moved.latitude + span.latitudeSpan / 2;
  let west = moved.longitude - span.longitudeSpan / 2;
  let east = moved.longitude + span.longitudeSpan / 2;
  if (north > MAX_LATITUDE) {
    south -= north - MAX_LATITUDE;
    north = MAX_LATITUDE;
  }
  if (south < -MAX_LATITUDE) {
    north += -MAX_LATITUDE - south;
    south = -MAX_LATITUDE;
  }
  if (east > MAX_LONGITUDE) {
    west -= east - MAX_LONGITUDE;
    east = MAX_LONGITUDE;
  }
  if (west < -MAX_LONGITUDE) {
    east += -MAX_LONGITUDE - west;
    west = -MAX_LONGITUDE;
  }
  return { south, west, north, east };
};
