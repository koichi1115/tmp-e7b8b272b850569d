import {
  MAX_BBOX_AREA_M2,
  OVERPASS_ENDPOINT,
  RangePreparationError,
  bboxSize,
  buildOverpassQuery,
  prepareFixture,
  validateBbox,
} from "./free-range";
import {
  PREPARED_FIXTURE_KEY,
  type Bbox,
  type FixtureData,
} from "./fixture";

type SetupOptions = Readonly<{
  initialError: string;
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

const tilePoint = (
  latitude: number,
  longitude: number,
  zoom: number,
) => {
  const scale = 2 ** zoom;
  const latitudeRadians = (latitude * Math.PI) / 180;
  return {
    x: ((longitude + 180) / 360) * scale * 256,
    y:
      ((1 -
        Math.asinh(Math.tan(latitudeRadians)) / Math.PI) /
        2) *
      scale *
      256,
  };
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
  const inputs = {
    south: element<HTMLInputElement>("#bbox-south"),
    west: element<HTMLInputElement>("#bbox-west"),
    north: element<HTMLInputElement>("#bbox-north"),
    east: element<HTMLInputElement>("#bbox-east"),
  };

  const readBbox = (): Bbox => ({
    south: Number(inputs.south.value),
    west: Number(inputs.west.value),
    north: Number(inputs.north.value),
    east: Number(inputs.east.value),
  });

  const showError = (message: string): void => {
    error.textContent = message;
    error.hidden = message.length === 0;
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

  const renderBasemap = (): void => {
    const bbox = readBbox();
    validateBbox(bbox);
    const zoom = 16;
    const center = tilePoint(
      (bbox.south + bbox.north) / 2,
      (bbox.west + bbox.east) / 2,
      zoom,
    );
    const tileX = Math.floor(center.x / 256) - 1;
    const tileY = Math.floor(center.y / 256) - 1;
    const columns = 3;
    const rows = 2;
    const images: string[] = [];
    for (let y = tileY; y < tileY + rows; y += 1) {
      for (let x = tileX; x < tileX + columns; x += 1) {
        images.push(
          `<img alt="" src="https://tile.openstreetmap.org/${zoom}/${x}/${y}.png">`,
        );
      }
    }
    const northWest = tilePoint(bbox.north, bbox.west, zoom);
    const southEast = tilePoint(bbox.south, bbox.east, zoom);
    const gridLeft = tileX * 256;
    const gridTop = tileY * 256;
    const left = ((northWest.x - gridLeft) / (columns * 256)) * 100;
    const top = ((northWest.y - gridTop) / (rows * 256)) * 100;
    const width =
      ((southEast.x - northWest.x) / (columns * 256)) * 100;
    const height =
      ((southEast.y - northWest.y) / (rows * 256)) * 100;
    map.innerHTML = `
      <div class="range-tiles">${images.join("")}</div>
      <div
        class="range-box"
        style="left:${left}%;top:${top}%;width:${width}%;height:${height}%"
      ></div>
    `;
    map.dataset.loaded = "true";
  };

  for (const input of Object.values(inputs)) {
    input.addEventListener("input", updateArea);
  }

  openButton.addEventListener("click", () => {
    showError("");
    updateArea();
    dialog.showModal();
    try {
      renderBasemap();
    } catch (reason) {
      showError(
        reason instanceof Error ? reason.message : "地図を表示できません。",
      );
    }
  });

  refreshMap.addEventListener("click", () => {
    showError("");
    updateArea();
    try {
      renderBasemap();
    } catch (reason) {
      showError(
        reason instanceof Error ? reason.message : "地図を表示できません。",
      );
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
      const capturedAt = new Date().toISOString();
      const fixture = prepareFixture(
        response.payload as { elements?: readonly unknown[] },
        bbox,
        {
          place: "準備した範囲",
          capturedAt,
          endpoint: response.endpoint,
          query,
        },
      );
      localStorage.setItem(
        PREPARED_FIXTURE_KEY,
        JSON.stringify(fixture),
      );
      options.onPrepared(fixture);
      dialog.dataset.state = "prepared";
      dialog.close();
    } catch (reason) {
      showError(
        reason instanceof Error
          ? reason.message
          : "範囲を準備できませんでした。",
      );
    } finally {
      prepare.disabled = false;
      prepare.textContent = "準備する";
    }
  });

  useDemo.addEventListener("click", () => {
    localStorage.removeItem(PREPARED_FIXTURE_KEY);
    options.onDemo();
    dialog.close();
  });

  updateArea();
  if (options.initialError) {
    queueMicrotask(() => {
      dialog.showModal();
      showError(options.initialError);
    });
  }
};