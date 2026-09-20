import assert from "node:assert/strict";
import test from "node:test";
import {
  runPressureV6LeaveOneBatchOutBacktest,
  type PressureV6BacktestModel,
} from "../src/SERVICES/cellering/pressurePredictionV6Backtest";

function successfulBatch(
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

function correctedBatch(
  id: string,
  firstPressure: number,
  correctedPressure = 1.15,
) {
  return {
    batchId: id,
    measurements: [
      {
        id: "2026-05-01_0800",
        temp: 20,
        pressure: 1.58,
        notes: "קירור מיכל ל-0.3",
      },
      {
        id: "2026-05-02_0900",
        carbonation: 2.26,
        temp: 6.5,
        pressure: 1.44,
        notes: `הורדת לחץ ל${firstPressure.toFixed(2)} bar`,
      },
      {
        id: "2026-05-03_0900",
        carbonation: 2.32,
        temp: 2.2,
        pressure: 1.30,
        notes: `הורדת לחץ ל${correctedPressure.toFixed(2)} bar`,
      },
      {
        id: "2026-05-05_0900",
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

test("V6 outcome backtest does not punish a different pressure when similar actions succeeded", () => {
  const histories = [
    ...Array.from({ length: 8 }, (_, index) =>
      successfulBatch(
        `train-${index}`,
        1.15 + (index % 2) * 0.01,
      )
    ),
    successfulBatch("held-outlier", 1.50),
  ];

  const result = runPressureV6LeaveOneBatchOutBacktest({
    model: emptyModel,
    historicalBatches: histories,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
  });

  const heldOut = result.cases.find(
    (item) => item.batchId === "held-outlier",
  );
  assert.ok(heldOut);

  assert.ok(
    heldOut.predictedPressure < 1.35,
    `held-out batch leaked its 1.50 bar action into prediction: ${heldOut.predictedPressure}`,
  );
  assert.equal(heldOut.actualHumanPressure, 1.50);
  assert.ok(
    heldOut.imitationPressureErrorBar >= 0.15,
    "the model should be visibly different from the human pressure",
  );
  assert.equal(heldOut.counterfactualSupported, true);
  assert.ok(
    heldOut.modelEstimatedSuccessProbability !== null &&
      heldOut.modelEstimatedSuccessProbability >= 0.8,
    "a large imitation error must not count as a bad decision when similar model actions historically succeeded",
  );
});

test("V6 outcome backtest learns both successful first shots and decisions that needed correction", () => {
  const histories = [
    ...Array.from({ length: 10 }, (_, index) =>
      successfulBatch(
        `success-${index}`,
        1.14 + (index % 3) * 0.01,
      )
    ),
    ...Array.from({ length: 8 }, (_, index) =>
      correctedBatch(
        `corrected-${index}`,
        1.38 + (index % 3) * 0.02,
      )
    ),
  ];

  const result = runPressureV6LeaveOneBatchOutBacktest({
    model: emptyModel,
    historicalBatches: histories,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
  });

  assert.ok(result.labeledOutcomeCount > histories.length);
  assert.ok(result.successfulOutcomeCount > 0);
  assert.ok(result.failedOutcomeCount > 0);
  assert.ok(result.actualHumanFirstShotSuccessRate !== null);
  assert.ok(result.estimatedFirstShotSuccessRate !== null);
  assert.ok(result.counterfactualCoverage > 0);
  assert.ok(result.modelCoverage > 0);
  assert.ok(
    result.imitationPressureMaeBar !== null,
    "human imitation remains available only as a secondary diagnostic",
  );
});
