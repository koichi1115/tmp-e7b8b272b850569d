/**
 * 範囲の準備そのもの。Overpass から道路を取り、下書きとして持ち、
 * 「経由でコース確定」「おまかせで確定」から fixture を組み立てます。
 * 画面の見た目（印・一覧）も保存の仕組みも知らず、出来上がりは save に渡すだけです。
 */
import {
  DEFAULT_CHECKPOINT_FRACTIONS,
  OVERPASS_ENDPOINT,
  RangePreparationError,
  buildOverpassQuery,
  generateLap,
  prepareFixture,
  prepareRoads,
  validateBbox,
} from "./free-range.ts";
import type { Bbox, FixtureData, FixtureRoad } from "./fixture.ts";
import { buildViaLap, withViaCourse, type ViaGraph } from "./via-lap.ts";

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

export type RangePreparePorts = Readonly<{
  dialog: HTMLDialogElement;
  prepareButton: HTMLButtonElement;
  autoConfirm: HTMLButtonElement;
  readBbox: () => Bbox;
  showError: (message: string, code?: string) => void;
  /** 道路が取れた直後。交差点の印を作り直すために使います。 */
  onRoadsReady: (roads: readonly FixtureRoad[], bbox: Bbox) => void;
  /** 地図の描き直し。 */
  redraw: () => void;
  /** 出来上がった fixture の保存と反映。 */
  save: (
    bbox: Bbox,
    fixture: FixtureData,
    viaNodeIds: readonly number[],
  ) => void;
}>;

export type RangePreparation = Readonly<{
  /** 経由順から周回路を作って確定します。 */
  confirmVia: (graph: ViaGraph | null, viaNodeIds: readonly number[]) => void;
  /** 保存から戻した fixture を、通信なしの下書きとして持ちます。 */
  adoptFixture: (fixture: FixtureData) => void;
  /** 下書きを捨てます。 */
  forget: () => void;
}>;

export const setupRangePrepare = (
  ports: RangePreparePorts,
): RangePreparation => {
  const { dialog } = ports;
  let draft: Draft | null = null;

  const describe = (reason: unknown): void => {
    ports.showError(
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

  const confirmVia = (
    graph: ViaGraph | null,
    viaNodeIds: readonly number[],
  ): void => {
    ports.showError("");
    if (!draft || !graph) {
      ports.showError("先に範囲を準備してください。", "not_prepared");
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
      ports.save(draft.bbox, fixture, lap.viaNodeIds);
    } catch (reason) {
      describe(reason);
    }
  };

  ports.autoConfirm.addEventListener("click", () => {
    ports.showError("");
    if (!draft) {
      ports.showError("先に範囲を準備してください。", "not_prepared");
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
      ports.save(draft.bbox, fixture, []);
    } catch (reason) {
      describe(reason);
    }
  });

  ports.prepareButton.addEventListener("click", async () => {
    ports.showError("");
    const bbox = ports.readBbox();
    try {
      validateBbox(bbox);
      ports.prepareButton.disabled = true;
      ports.prepareButton.textContent = "取得・生成中…";
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
      ports.onRoadsReady(roads, bbox);
      dialog.dataset.state = "graph";
      ports.redraw();
    } catch (reason) {
      describe(reason);
    } finally {
      ports.prepareButton.disabled = false;
      ports.prepareButton.textContent = "準備する";
    }
  });

  return {
    confirmVia,
    adoptFixture: (fixture) => {
      draft = {
        kind: "fixture",
        bbox: fixture.bbox,
        roads: fixture.roads,
        fixture,
      };
    },
    forget: () => {
      draft = null;
    },
  };
};
