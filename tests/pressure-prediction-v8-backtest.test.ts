import assert from "node:assert/strict";
import test from "node:test";
import {
  runPressureV8LeaveOneBatchOutBacktest,
} from "../src/SERVICES/cellering/pressurePredictionV8Backtest";
import type {
  PressureV6BacktestModel,
} from "../src/SERVICES/cellering/pressurePredictionV6Backtest";

function batch(
  id: string,
  treatmentDelta: number,
  success: boolean,
) {
  const actionPressure = 1.44 + treatmentDelta;
  const decisionNote =
    Math.abs(treatmentDelta) < 0.05
      ? ""
      : `הורדת לחץ ל${actionPressure.toFixed(2)} bar`;

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
        notes: decisionNote,
      },
      success
        ? {
            id: "2026-06-05_0900",
            carbonation: 2.45,
            temp: 0.7,
            pressure: 0.65,
            notes: "",
          }
        : {
            id: "2026-06-03_0900",
            temp: 2.0,
            pressure: 1.20,
            notes: "גיזוז מלמטה",
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

test("V8 cross-fit backtest keeps selector and evaluator independent", () => {
  const histories = [
    ...Array.from({ length: 24 }, (_, index) =>
      batch(
        `hold-${index}`,
        0,
        index % 2 === 0,
      )
    ),
    ...Array.from({ length: 24 }, (_, index) =>
      batch(
        `treat-${index}`,
        -0.20,
        index % 6 !== 0,
      )
    ),
  ];

  const result = runPressureV8LeaveOneBatchOutBacktest({
    model: emptyModel,
    historicalBatches: histories,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
  });

  assert.ok(result.eligibleCaseCount > 0);
  assert.ok(result.predictedCaseCount > 0);

  for (const item of result.cases) {
    assert.ok((item.selectorTrainingBatches ?? 0) >= 8);
    assert.ok((item.evaluatorTrainingBatches ?? 0) >= 8);
  }

  assert.ok(result.modelCoverage > 0);
  assert.ok(
    (result.observedEvaluationRate ?? 0) +
      (result.counterfactualEvaluationRate ?? 0) <=
      1.0001,
  );
});
