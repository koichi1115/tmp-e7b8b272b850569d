/**
 * 準備済み範囲の保存記録。範囲 bbox・経由順・fixture を一つの版付き記録に収めます。
 * DOM も通信も持たず、読めない記録は握り潰さず必ず例外にします。
 */
import type { Bbox, FixtureData } from "./fixture.ts";

export const PREPARED_RECORD_VERSION = 3;

export type PreparedRecordErrorCode = "parse" | "shape" | "version";

export class PreparedRecordError extends Error {
  readonly code: PreparedRecordErrorCode;

  constructor(code: PreparedRecordErrorCode, message: string) {
    super(`保存データを読めませんでした（${code}）。${message}`);
    this.name = "PreparedRecordError";
    this.code = code;
  }
}

export type PreparedRecord = Readonly<{
  recordVersion: number;
  bbox: Bbox;
  viaNodeIds: readonly number[];
  fixture: FixtureData;
}>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === "number" && Number.isFinite(entry));

const readBbox = (value: unknown, owner: string): Bbox => {
  if (!isObject(value)) {
    throw new PreparedRecordError("shape", `${owner}の範囲がありません。`);
  }
  const bbox = {
    south: value.south,
    west: value.west,
    north: value.north,
    east: value.east,
  };
  for (const [name, entry] of Object.entries(bbox)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new PreparedRecordError(
        "shape",
        `${owner}の範囲 ${name} が数値ではありません。`,
      );
    }
  }
  return bbox as Bbox;
};

const readFixture = (value: unknown): FixtureData => {
  if (!isObject(value)) {
    throw new PreparedRecordError("shape", "コースデータがありません。");
  }
  if (value.schemaVersion !== 2) {
    throw new PreparedRecordError(
      "version",
      `知らないコースデータ版 ${String(value.schemaVersion)} です。`,
    );
  }
  readBbox(value.bbox, "コースデータ");
  if (typeof value.place !== "string") {
    throw new PreparedRecordError("shape", "場所の名前がありません。");
  }
  if (!isObject(value.source)) {
    throw new PreparedRecordError("shape", "出典がありません。");
  }
  if (!Array.isArray(value.roads) || value.roads.length === 0) {
    throw new PreparedRecordError("shape", "道路がありません。");
  }
  if (!Array.isArray(value.buildings) || !Array.isArray(value.landAreas)) {
    throw new PreparedRecordError("shape", "地物の形が違います。");
  }
  const course = value.course;
  if (!isObject(course)) {
    throw new PreparedRecordError("shape", "コースがありません。");
  }
  if (
    !isNumberArray(course.lapNodeIds) ||
    !isNumberArray(course.checkpointFractions) ||
    typeof course.lapLengthMeters !== "number" ||
    typeof course.roadWidthMeters !== "number"
  ) {
    throw new PreparedRecordError("shape", "コースの形が違います。");
  }
  if (
    course.viaNodeIds !== undefined &&
    !isNumberArray(course.viaNodeIds)
  ) {
    throw new PreparedRecordError("shape", "経由順の形が違います。");
  }
  return value as unknown as FixtureData;
};

export const serializePreparedRecord = (
  record: Readonly<{
    bbox: Bbox;
    viaNodeIds: readonly number[];
    fixture: FixtureData;
  }>,
): string =>
  JSON.stringify({
    recordVersion: PREPARED_RECORD_VERSION,
    bbox: record.bbox,
    viaNodeIds: [...record.viaNodeIds],
    fixture: record.fixture,
  });

export const parsePreparedRecord = (text: string): PreparedRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (reason) {
    throw new PreparedRecordError(
      "parse",
      reason instanceof Error
        ? `JSONとして読めません: ${reason.message}`
        : "JSONとして読めません。",
    );
  }
  if (!isObject(parsed)) {
    throw new PreparedRecordError("shape", "記録が対象の形ではありません。");
  }

  // 版の無い記録は、スライス10までの「fixture をそのまま入れた」保存です。
  if (parsed.recordVersion === undefined) {
    const fixture = readFixture(parsed);
    return {
      recordVersion: PREPARED_RECORD_VERSION,
      bbox: fixture.bbox,
      viaNodeIds: fixture.course.viaNodeIds ?? [],
      fixture,
    };
  }
  if (parsed.recordVersion !== PREPARED_RECORD_VERSION) {
    throw new PreparedRecordError(
      "version",
      `知らない記録版 ${String(parsed.recordVersion)} です。いまの版は ${PREPARED_RECORD_VERSION} です。`,
    );
  }
  const bbox = readBbox(parsed.bbox, "記録");
  if (!isNumberArray(parsed.viaNodeIds)) {
    throw new PreparedRecordError("shape", "経由順が数値の並びではありません。");
  }
  const fixture = readFixture(parsed.fixture);
  return {
    recordVersion: PREPARED_RECORD_VERSION,
    bbox,
    viaNodeIds: parsed.viaNodeIds,
    fixture,
  };
};
