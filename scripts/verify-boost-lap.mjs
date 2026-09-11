import {
  HARD_SPEED_CAP_MPS,
  boostedSpeedCap,
  evaluatePadPlacement,
} from "../src/boost-pads.ts";
import { course, pointAtProgress } from "../src/course.ts";
import { vehicleMaxSpeed } from "../src/vehicles.ts";
import { driveLap } from "./lap-simulation.mjs";

// Fixed placements on the committed lap. Every fraction is checked against
// the same fail-closed rule the build mode uses, so this script proves the
// rule and the boost with one set of numbers.
const PAD_FRACTIONS = [0.12, 0.3, 0.5, 0.55, 0.9];

const padsFor = (count) => {
  const pads = [];
  for (const fraction of PAD_FRACTIONS.slice(0, count)) {
    const placement = evaluatePadPlacement(
      course,
      pads,
      pointAtProgress(course, fraction).point,
    );
    if (!placement.accepted) {
      throw new Error(
        `進捗 ${fraction} の加速パッドが拒否されました: ${placement.reason}`,
      );
    }
    pads.push(placement.pad);
  }
  return pads;
};

const report = {};
let failed = false;

for (const vehicleId of ["street", "alley"]) {
  const baseline = driveLap(course, vehicleId, []);
  const twoPads = driveLap(course, vehicleId, padsFor(2));
  const fivePads = driveLap(course, vehicleId, padsFor(5));
  const runs = { パッドなし: baseline, パッド2個: twoPads, パッド5個: fivePads };

  report[vehicleId] = {
    基準最高速度ms: vehicleMaxSpeed(vehicleId),
    加速時の上限ms: boostedSpeedCap(vehicleId),
    固定上限ms: HARD_SPEED_CAP_MPS,
    走行: Object.fromEntries(
      Object.entries(runs).map(([name, run]) => [
        name,
        {
          完走: run.finished,
          通過ゲート数: run.checkpointsPassed,
          ラップ秒: Number((run.lapMs / 1_000).toFixed(3)),
          最高速度ms: Number(run.peakSpeed.toFixed(3)),
          パッド踏破回数: run.boostHits,
        },
      ]),
    ),
    差分: {
      ラップ短縮秒2個: Number(
        ((baseline.lapMs - twoPads.lapMs) / 1_000).toFixed(3),
      ),
      ラップ短縮秒5個: Number(
        ((baseline.lapMs - fivePads.lapMs) / 1_000).toFixed(3),
      ),
      最高速度上昇ms5個: Number(
        (fivePads.peakSpeed - baseline.peakSpeed).toFixed(3),
      ),
    },
  };

  const checks = {
    基準が完走する: baseline.finished,
    パッド2個で完走する: twoPads.finished,
    パッド5個で完走する: fivePads.finished,
    パッド2個で踏破が増える: twoPads.boostHits === 2,
    パッド5個で踏破が増える: fivePads.boostHits === 5,
    パッド2個でラップが速い: twoPads.lapMs < baseline.lapMs,
    パッド5個でラップがさらに速い: fivePads.lapMs < twoPads.lapMs,
    基準は車両上限を超えない:
      baseline.peakSpeed <= vehicleMaxSpeed(vehicleId) + 1e-9,
    加速で車両上限を超える:
      fivePads.peakSpeed > vehicleMaxSpeed(vehicleId) + 0.5,
    固定上限を超えない: fivePads.peakSpeed <= HARD_SPEED_CAP_MPS + 1e-9,
  };
  report[vehicleId].検査 = checks;
  if (Object.values(checks).some((value) => value !== true)) {
    failed = true;
  }
}

console.log(JSON.stringify(report, null, 2));

if (failed) {
  process.exitCode = 1;
  console.error("加速パッドのラップ比較に失敗しました。");
} else {
  console.log("加速パッドのラップ比較に成功しました。");
}
