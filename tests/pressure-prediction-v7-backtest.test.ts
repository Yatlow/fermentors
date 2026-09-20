import assert from "node:assert/strict";
import test from "node:test";
import {
  runPressureV7LeaveOneBatchOutBacktest,
} from "../src/SERVICES/cellering/pressurePredictionV7Backtest";
import type {
  PressureV6BacktestModel,
} from "../src/SERVICES/cellering/pressurePredictionV6Backtest";

function batch(
  id: string,
  actionPressure: number,
  success: boolean,
) {
  const measurements = [
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
  ];

  if (success) {
    measurements.push({
      id: "2026-06-05_0900",
      carbonation: 2.45,
      temp: 0.7,
      pressure: 0.65,
      notes: "",
    });
  } else {
    measurements.push({
      id: "2026-06-03_0900",
      carbonation: 2.33,
      temp: 2.0,
      pressure: 1.30,
      notes: "הורדת לחץ ל1.15 bar",
    });
    measurements.push({
      id: "2026-06-05_0900",
      carbonation: 2.45,
      temp: 0.7,
      pressure: 0.65,
      notes: "",
    });
  }

  return { batchId: id, measurements };
}

const emptyModel: PressureV6BacktestModel = {
  style: "ipa",
  samples: [],
  passiveSamples: [],
  transitions: [],
  equilibriumPoints: [],
};

test("V7 backtest uses disjoint selector and evaluator batch sets", () => {
  const histories = [
    ...Array.from({ length: 16 }, (_, index) =>
      batch(
        `good-${index}`,
        1.12 + (index % 3) * 0.02,
        true,
      )
    ),
    ...Array.from({ length: 12 }, (_, index) =>
      batch(
        `bad-${index}`,
        1.34 + (index % 3) * 0.02,
        false,
      )
    ),
  ];

  const result = runPressureV7LeaveOneBatchOutBacktest({
    model: emptyModel,
    historicalBatches: histories,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
  });

  assert.ok(result.predictedCaseCount > 0);
  for (const item of result.cases) {
    assert.ok((item.selectorTrainingBatches ?? 0) >= 4);
    assert.ok((item.evaluatorTrainingBatches ?? 0) >= 4);
    assert.ok(
      item.evaluationMode === "observed" ||
      item.evaluationMode === "counterfactual",
    );
  }

  assert.ok(
    (result.observedEvaluationRate ?? 0) +
      (result.counterfactualEvaluationRate ?? 0) <=
      1.0001,
  );
});

test("V7 backtest uses the held-out real outcome when it independently chooses the same pressure", () => {
  const histories = Array.from({ length: 24 }, (_, index) =>
    batch(
      `same-${index}`,
      1.15 + (index % 2) * 0.01,
      true,
    )
  );

  const result = runPressureV7LeaveOneBatchOutBacktest({
    model: emptyModel,
    historicalBatches: histories,
    targetCarbonation: 2.45,
    targetToleranceVol: 0.03,
  });

  const observed = result.cases.filter(
    (item) => item.evaluationMode === "observed",
  );
  assert.ok(observed.length > 0);
  assert.ok(
    observed.every(
      (item) => item.modelEstimatedSuccessProbability === 1,
    ),
  );
});
