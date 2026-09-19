import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePressureTargetV4,
  type PressureV4DecisionState,
} from "../src/SERVICES/cellering/pressurePredictionV4Estimator";
import type {
  PressureV4CoolingState,
  PressureV4Exposure,
  PressureV4TransitionSample,
} from "../src/SERVICES/cellering/pressurePredictionV4";
import {
  equilibriumPressureBar,
  evolveCarbonation,
} from "../src/SERVICES/cellering/pressureCarbonationPhysics";

function exposure(
  pressure: number,
  hours = 144,
  eqRate = 0.05,
): PressureV4Exposure {
  return {
    hoursSinceT0: hours,
    pressureHours: pressure * hours,
    temperatureHours: 2 * hours,
    equilibriumDeltaBarHours: eqRate * hours,
    pressureMean: pressure,
    pressureMean24h: pressure,
    pressureMean48h: pressure,
    temperatureMean: 2,
    pressurePoints: 8,
    temperaturePoints: 8,
    coveredHours: hours,
    coverageRatio: 1,
  };
}

function cooling(args: {
  hours: number;
  currentTemp: number;
  pressure: number;
  stillCooling?: boolean;
  startTemp?: number;
  tempChange24h?: number;
}): PressureV4CoolingState {
  const startTemp = args.startTemp ?? 14;
  return {
    startDateTimeMs: 0,
    hoursSinceCooling: args.hours,
    startTemp,
    currentTemp: args.currentTemp,
    tempDropSinceCooling: startTemp - args.currentTemp,
    tempChange24h:
      args.tempChange24h ??
      (args.stillCooling ? -3 : -0.1),
    pressureMeanSinceCooling: args.pressure,
    pressureMean24h: args.pressure,
    pressureHoursSinceCooling: args.pressure * args.hours,
    equilibriumDeltaBarHoursSinceCooling: 0.05 * args.hours,
    coverageRatio: 1,
    stillCooling: args.stillCooling ?? false,
  };
}

function transition(
  index: number,
  args: {
    k?: number;
    currentTemp?: number;
    pressure?: number;
    hoursSinceT0?: number;
    cooling?: PressureV4CoolingState | null;
    startCarbonation?: number;
  } = {},
): PressureV4TransitionSample {
  const k = args.k ?? 0.004;
  const currentTemp = args.currentTemp ?? 1;
  const pressure = args.pressure ?? 0.8;
  const startCarbonation = args.startCarbonation ?? 2.35;
  const durationHours = 48;
  const after = evolveCarbonation({
    carbonation: startCarbonation,
    pressureBar: pressure,
    temperatureC: currentTemp,
    kPerHour: k,
    hours: durationHours,
  });
  if (after === null) throw new Error("invalid synthetic transition");

  return {
    batchId: `b-${index}`,
    style: "test",
    startDateTimeMs: index * 100_000_000,
    endDateTimeMs: index * 100_000_000 + durationHours * 3600000,
    durationHours,
    startCarbonation,
    endCarbonation: after,
    currentPressure: pressure,
    currentTemp,
    hoursSinceT0: args.hoursSinceT0 ?? 144,
    exposure: exposure(pressure, args.hoursSinceT0 ?? 144),
    cooling: args.cooling ?? null,
    pressureMeanDuring: pressure,
    temperatureMeanDuring: currentTemp,
    kPerHour: k,
    quality: "high",
  };
}

function transitionsFor(
  state: PressureV4DecisionState,
  k: number,
): PressureV4TransitionSample[] {
  return Array.from({ length: 16 }, (_, index) =>
    transition(index, {
      k: k * (0.9 + (index % 5) * 0.05),
      currentTemp: state.currentTemp ?? 1,
      pressure:
        (state.exposure.pressureMean24h ?? state.currentPressure) +
        ((index % 3) - 1) * 0.03,
      hoursSinceT0:
        state.hoursSinceT0 + ((index % 3) - 1) * 12,
      cooling: state.cooling
        ? {
            ...state.cooling,
            hoursSinceCooling:
              state.cooling.hoursSinceCooling +
              ((index % 3) - 1) * 12,
          }
        : null,
      startCarbonation:
        state.carbonation + ((index % 3) - 1) * 0.01,
    }),
  );
}

test("standard equilibrium remains the physical baseline", () => {
  const pressure = equilibriumPressureBar(6.8, 2.45);
  assert.ok(pressure !== null);
  assert.ok(pressure > 0.93 && pressure < 0.99);
});

test("tank 15 style demo: exact target holds current pressure", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.4,
    currentPressure: 0.4,
    currentTemp: 0.4,
    hoursSinceT0: 420,
    exposure: exposure(0.4, 420),
    cooling: cooling({
      hours: 372,
      currentTemp: 0.4,
      pressure: 0.4,
    }),
    carbonationTrend: {
      checksInPhase: 6,
      previousCarbonation: 2.4,
      previousDateTimeMs: 0,
      hoursSincePrevious: 48,
      deltaFromPrevious: 0,
      ratePerDay: 0,
    },
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.00038),
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 0.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "hold");
  assert.equal(estimate.targetPressure, 0.4);
});

test("tank 15 style demo: low carbonation makes a moderate raise, not 1.85 bar", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.33,
    currentPressure: 0.4,
    currentTemp: 0.4,
    hoursSinceT0: 420,
    exposure: exposure(0.4, 420),
    cooling: cooling({
      hours: 372,
      currentTemp: 0.4,
      pressure: 0.4,
    }),
    carbonationTrend: {
      checksInPhase: 6,
      previousCarbonation: 2.4,
      previousDateTimeMs: 0,
      hoursSincePrevious: 48,
      deltaFromPrevious: -0.07,
      ratePerDay: -0.035,
    },
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.00038),
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 0.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "raise");
  assert.ok(
    estimate.targetPressure >= 0.75 && estimate.targetPressure <= 0.85,
    `expected about 0.8 bar, got ${estimate.targetPressure}`,
  );
});

test("tank 15 style demo: high carbonation vents aggressively", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.47,
    currentPressure: 0.4,
    currentTemp: 0.4,
    hoursSinceT0: 420,
    exposure: exposure(0.4, 420),
    cooling: cooling({
      hours: 372,
      currentTemp: 0.4,
      pressure: 0.4,
    }),
    carbonationTrend: {
      checksInPhase: 6,
      previousCarbonation: 2.4,
      previousDateTimeMs: 0,
      hoursSincePrevious: 48,
      deltaFromPrevious: 0.07,
      ratePerDay: 0.035,
    },
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.00038),
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 0.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "lower");
  assert.ok(
    estimate.targetPressure >= 0 && estimate.targetPressure <= 0.15,
    `expected strong venting, got ${estimate.targetPressure}`,
  );
});

test("tank 17 style demo: stable local balance anchors a small low-carb correction near 1 bar", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.39,
    currentPressure: 0.83,
    currentTemp: 0.6,
    hoursSinceT0: 300,
    exposure: exposure(0.83, 300),
    cooling: cooling({
      hours: 255,
      currentTemp: 0.6,
      pressure: 0.83,
    }),
    carbonationTrend: {
      checksInPhase: 4,
      previousCarbonation: 2.39,
      previousDateTimeMs: 0,
      hoursSincePrevious: 48,
      deltaFromPrevious: 0,
      ratePerDay: 0,
    },
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.0007),
    state,
    targetCarbonation: 2.45,
    equilibriumPressure: 0.6,
    coldReferenceTemperature: 0.6,
  });

  assert.ok(estimate);
  assert.equal(estimate.equilibriumSource, "local_stable");
  assert.equal(estimate.action, "raise");
  assert.ok(
    estimate.targetPressure >= 0.95 && estimate.targetPressure <= 1.05,
    `expected roughly 0.95-1.0 bar, got ${estimate.targetPressure}`,
  );
});

test("tank 16 style demo: first cold check uses stored pressure/cooling headroom and lowers 1.44 toward 1.1", () => {
  const earlyCooling = cooling({
    hours: 64,
    currentTemp: 6.8,
    pressure: 1.35,
    stillCooling: true,
    tempChange24h: -3.5,
  });
  const state: PressureV4DecisionState = {
    carbonation: 2.26,
    currentPressure: 1.44,
    currentTemp: 6.8,
    hoursSinceT0: 96,
    exposure: exposure(1.35, 96, 0.45),
    cooling: earlyCooling,
    carbonationTrend: {
      checksInPhase: 1,
      previousCarbonation: null,
      previousDateTimeMs: null,
      hoursSincePrevious: null,
      deltaFromPrevious: null,
      ratePerDay: null,
    },
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.00144),
    state,
    targetCarbonation: 2.45,
    equilibriumPressure: 0.6,
    coldReferenceTemperature: 0.6,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "lower");
  assert.ok(
    estimate.targetPressure >= 1.05 && estimate.targetPressure <= 1.15,
    `expected roughly 1.1 bar, got ${estimate.targetPressure}`,
  );
});

test("warm tank is outside the cold-carbonation calculator", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.39,
    currentPressure: 1.64,
    currentTemp: 21.3,
    hoursSinceT0: 72,
    exposure: exposure(1.64, 72),
    cooling: null,
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.004),
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 1.5,
  });

  assert.equal(estimate, null);
});

test("k changes the forecast but does not force an extreme pressure target", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.33,
    currentPressure: 0.4,
    currentTemp: 0.4,
    hoursSinceT0: 420,
    exposure: exposure(0.4, 420),
    cooling: cooling({
      hours: 372,
      currentTemp: 0.4,
      pressure: 0.4,
    }),
    carbonationTrend: null,
  };

  const slow = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.0002),
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 0.4,
  });
  const faster = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.005),
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 0.4,
  });

  assert.ok(slow);
  assert.ok(faster);
  assert.equal(slow.targetPressure, faster.targetPressure);
  assert.notEqual(
    slow.predictedCarbonation,
    faster.predictedCarbonation,
    "k should affect forecast, not the operational pressure target",
  );
});
