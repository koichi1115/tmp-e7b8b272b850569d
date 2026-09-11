import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOST_DURATION_MS,
  BOOST_MULTIPLIER,
  BOOST_PADS_KEY,
  GATE_CLEARANCE_METERS,
  HARD_SPEED_CAP_MPS,
  PAD_CORRIDOR_MARGIN_METERS,
  PAD_MIN_SEPARATION_METERS,
  boostedSpeedCap,
  clampBoostedSpeed,
  evaluatePadPlacement,
  gatePositions,
  loadPads,
  padUnderPoint,
  removePadAt,
  savePads,
  serializePads,
  type BoostPad,
  type PadStorage,
} from "../src/boost-pads.ts";
import { stepWalker } from "../src/build-mode.ts";
import {
  course,
  nearestCoursePosition,
  pointAtProgress,
} from "../src/course.ts";
import { vehicleMaxSpeed } from "../src/vehicles.ts";
import { driveLap } from "../scripts/lap-simulation.mjs";

const onCourse = (fraction: number) =>
  pointAtProgress(course, fraction).point;

const acrossCourse = (fraction: number, meters: number) => {
  const spot = pointAtProgress(course, fraction);
  return {
    x: spot.point.x - spot.tangent.y * meters,
    y: spot.point.y + spot.tangent.x * meters,
  };
};

const memoryStorage = (): PadStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

const placePads = (fractions: readonly number[]): readonly BoostPad[] => {
  const pads: BoostPad[] = [];
  for (const fraction of fractions) {
    const placement = evaluatePadPlacement(
      course,
      pads,
      onCourse(fraction),
    );
    assert.equal(
      placement.accepted,
      true,
      `進捗 ${fraction} が拒否されました。`,
    );
    if (placement.accepted) {
      pads.push(placement.pad);
    }
  }
  return pads;
};

test("路面の回廊内なら設置を受け入れる", () => {
  const inside = acrossCourse(0.3, course.roadWidth / 2 - 1);
  const placement = evaluatePadPlacement(course, [], inside);
  assert.equal(placement.accepted, true);
  if (!placement.accepted) {
    return;
  }
  assert.equal(placement.pad.id, "pad-1");
  const nearest = nearestCoursePosition(course, inside);
  assert.ok(
    Math.abs(
      Math.atan2(
        Math.sin(
          Math.atan2(nearest.tangent.y, nearest.tangent.x) -
            placement.pad.heading,
        ),
        Math.cos(
          Math.atan2(nearest.tangent.y, nearest.tangent.x) -
            placement.pad.heading,
        ),
      ),
    ) < 1e-9,
    "パッドの向きが最寄り区間と一致しません。",
  );
});

test("回廊の外は拒否して何も保存しない", () => {
  const storage = memoryStorage();
  const outside = acrossCourse(
    0.3,
    course.roadWidth / 2 + PAD_CORRIDOR_MARGIN_METERS + 0.5,
  );
  const placement = evaluatePadPlacement(course, [], outside);
  assert.equal(placement.accepted, false);
  if (placement.accepted) {
    return;
  }
  assert.equal(placement.reason, "corridor");
  assert.ok(placement.message.length > 0);
  assert.equal(storage.values.size, 0);
});

test("既存パッドと重なる位置は拒否する", () => {
  const pads = placePads([0.3]);
  const nearby = pointAtProgress(
    course,
    0.3 + (PAD_MIN_SEPARATION_METERS - 4) / course.lapLength,
  ).point;
  const placement = evaluatePadPlacement(course, pads, nearby);
  assert.equal(placement.accepted, false);
  if (!placement.accepted) {
    assert.equal(placement.reason, "pad");
  }
});

test("ゲートの判定範囲に重なる位置は拒否する", () => {
  const gateFraction = course.checkpointFractions[0];
  assert.ok(gateFraction !== undefined);
  const placement = evaluatePadPlacement(
    course,
    [],
    onCourse(gateFraction),
  );
  assert.equal(placement.accepted, false);
  if (!placement.accepted) {
    assert.equal(placement.reason, "gate");
  }
  assert.equal(gatePositions(course).length, 5);
  const justOutside = pointAtProgress(
    course,
    gateFraction + (GATE_CLEARANCE_METERS + 2) / course.lapLength,
  ).point;
  assert.equal(
    evaluatePadPlacement(course, [], justOutside).accepted,
    true,
  );
});

test("足元のパッドだけを撤去する", () => {
  const pads = placePads([0.3, 0.5]);
  const empty = removePadAt(pads, onCourse(0.7));
  assert.equal(empty.removed, null);
  assert.equal(empty.pads.length, 2);
  const removed = removePadAt(pads, onCourse(0.3));
  assert.equal(removed.removed?.id, "pad-1");
  assert.deepEqual(
    removed.pads.map((pad) => pad.id),
    ["pad-2"],
  );
  assert.equal(padUnderPoint(removed.pads, onCourse(0.3)), null);
});

test("徒歩移動は歩行速度で路面上を進む", () => {
  const start = { position: onCourse(0.3), heading: 0 };
  let walker = { ...start, heading: Math.atan2(0, 1) };
  for (let step = 0; step < 60; step += 1) {
    walker = stepWalker(
      walker,
      { accelerate: true, brake: false, left: false, right: false },
      1 / 60,
      course,
    );
  }
  const travelled = Math.hypot(
    walker.position.x - start.position.x,
    walker.position.y - start.position.y,
  );
  assert.ok(travelled > 2.3 && travelled < 2.5, `歩行距離 ${travelled}`);
});

test("加速は設定時間だけ倍率を与え、基準速度へ戻る", () => {
  const pads = placePads([0.3]);
  const run = driveLap(course, "street", pads, { sample: true });
  assert.equal(run.finished, true);
  assert.equal(run.boostHits, 1);

  const trigger = run.samples.findIndex(
    (sample: { boostRemainingMs: number }) => sample.boostRemainingMs > 0,
  );
  assert.ok(trigger >= 0, "加速が始まりませんでした。");
  assert.equal(run.samples[trigger].boostRemainingMs, BOOST_DURATION_MS);
  assert.equal(run.samples[trigger].boostPadId, "pad-1");

  const boostedSamples = run.samples.filter(
    (sample: { boostRemainingMs: number }) => sample.boostRemainingMs > 0,
  );
  const boostedSeconds = boostedSamples.length / 60;
  assert.ok(
    boostedSeconds >= BOOST_DURATION_MS / 1_000 &&
      boostedSeconds <= BOOST_DURATION_MS / 1_000 + 0.6,
    `加速時間 ${boostedSeconds} 秒`,
  );

  const base = vehicleMaxSpeed("street");
  assert.ok(
    run.peakBoostedSpeed > base + 0.5,
    `加速中の最高速度 ${run.peakBoostedSpeed} が基準 ${base} を超えません。`,
  );

  const last = boostedSamples.at(-1);
  const after = run.samples
    .slice(run.samples.indexOf(last) + 1)
    .filter(
      (sample: { boostRemainingMs: number }) =>
        sample.boostRemainingMs === 0,
    )
    .slice(0, 240);
  assert.ok(after.length > 0);
  for (const sample of after) {
    assert.ok(
      sample.speed <= base + 1e-9,
      `加速後の速度 ${sample.speed} が基準上限を超えています。`,
    );
  }
});

test("加速は固定上限で頭打ちになる", () => {
  assert.ok(
    vehicleMaxSpeed("street") * BOOST_MULTIPLIER > HARD_SPEED_CAP_MPS,
    "まちぐるまは倍率だけで固定上限を超える前提です。",
  );
  assert.equal(boostedSpeedCap("street"), HARD_SPEED_CAP_MPS);
  assert.equal(
    boostedSpeedCap("alley"),
    vehicleMaxSpeed("alley") * BOOST_MULTIPLIER,
  );
  assert.equal(clampBoostedSpeed(999, "street"), HARD_SPEED_CAP_MPS);
  assert.equal(clampBoostedSpeed(-99, "street"), -6);

  const chained = driveLap(
    course,
    "street",
    placePads([0.12, 0.3, 0.5, 0.55, 0.9]),
  );
  assert.equal(chained.finished, true);
  assert.equal(chained.boostHits, 5);
  assert.ok(
    chained.peakSpeed <= HARD_SPEED_CAP_MPS + 1e-9,
    `連続加速の最高速度 ${chained.peakSpeed}`,
  );
  assert.ok(chained.peakSpeed > vehicleMaxSpeed("street") + 0.5);
});

test("localStorage往復でパッドが復元される", () => {
  const storage = memoryStorage();
  const pads = placePads([0.3, 0.5]);
  savePads(course, pads, storage);
  assert.equal(storage.values.size, 1);
  assert.ok(storage.values.has(BOOST_PADS_KEY));
  assert.deepEqual(loadPads(course, storage), pads);
});

test("壊れた保存内容と別コースの保存は読み込まない", () => {
  const storage = memoryStorage();
  storage.setItem(BOOST_PADS_KEY, "{壊れた");
  assert.deepEqual(loadPads(course, storage), []);

  storage.setItem(
    BOOST_PADS_KEY,
    JSON.stringify({
      version: 1,
      courseKey: "別の場所|0, 0, 0, 0",
      pads: placePads([0.3]),
    }),
  );
  assert.deepEqual(loadPads(course, storage), []);
});

test("保存済みでも回廊外のパッドは読み込み時に捨てる", () => {
  const storage = memoryStorage();
  const valid = placePads([0.3]);
  const strayText = serializePads(course, [
    ...valid,
    {
      id: "pad-stray",
      ...acrossCourse(0.5, course.roadWidth / 2 + 25),
      heading: 0,
    },
  ]);
  storage.setItem(BOOST_PADS_KEY, strayText);
  assert.deepEqual(
    loadPads(course, storage).map((pad) => pad.id),
    ["pad-1"],
  );
});
