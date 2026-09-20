import assert from "node:assert/strict";
import test from "node:test";
import {
  runPressureV6LeaveOneBatchOutBacktest,
  type PressureV6BacktestModel,
} from "../src/SERVICES/cellering/pressurePredictionV6Backtest";

function batch(
  id: string,
  actionPressure: number,
) {
  return {
    batchId: id,
    measurements: [
      {
        id: "2026-06-01_0800",
        temp: 20,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: "2026-06-02_0900",
        carbonation: 2.26,
        temp: 6.5,
        pressure: 1.44,
        notes: `הורדת לחץ ל${actionPressure.toFixed(2)} bar`,
      },
      {
        id: "2026-06-05_0900",
        carbonation: 2.45,
        temp: 0.7,
        pressure: 0.65,
      },
    ],
  };
}

const emptyModel: PressureV6BacktestModel = {
  style: "ipa",
  samples: [],
  passiveSamples: [],
  transitions: [],
  equilibriumPoints: [],
};

test("V6 backtest hides the held-out batch action from its own prediction", () => {
  const histories = [
    ...Array.from({ length: 8 }, (_, index) =>
      batch(`train-${index}`, 1.15 + (index % 2) * 0.01)
    ),
    batch("held-outlier", 1.50),
  ];

  const result = runPressureV6LeaveOneBatchOutBacktest({
    model: emptyModel,
    historicalBatches: histories,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
  });

  assert.ok(result.predictedCaseCount >= 8);
  assert.ok(result.distinctBatchCount >= 8);

  const heldOut = result.cases.find(
    (item) => item.batchId === "held-outlier",
  );
  assert.ok(heldOut);

  assert.ok(
    heldOut.predictedPressure < 1.35,
    `held-out batch leaked its 1.50 bar action into prediction: ${heldOut.predictedPressure}`,
  );
  assert.equal(heldOut.actualPressure, 1.50);
  assert.ok(heldOut.pressureErrorBar >= 0.15);
});

test("V6 backtest reports human-readable error distribution metrics", () => {
  const histories = Array.from({ length: 10 }, (_, index) =>
    batch(
      `stable-${index}`,
      1.14 + (index % 3) * 0.01,
    )
  );

  const result = runPressureV6LeaveOneBatchOutBacktest({
    model: emptyModel,
    historicalBatches: histories,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
  });

  assert.ok(result.pressureMaeBar !== null);
  assert.ok(result.pressureP90AbsErrorBar !== null);
  assert.ok(result.directionAccuracy !== null);
  assert.ok(result.coverage > 0);
  assert.ok(result.within015Bar !== null);
});
