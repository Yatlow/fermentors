import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePressureTargetV4,
  type PressureV4DecisionState,
} from "../src/SERVICES/cellering/pressurePredictionV4Estimator";
import type {
  PressureV4CoolingState,
  PressureV4Exposure,
  PressureV4PassiveSample,
  PressureV4Sample,
  PressureV4TransitionSample,
} from "../src/SERVICES/cellering/pressurePredictionV4";
import {
  equilibriumPressureBar,
  evolveCarbonation,
} from "../src/SERVICES/cellering/pressureCarbonationPhysics";
import {
  estimateVentingDuration,
} from "../src/SERVICES/cellering/ventingEstimator";

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
    `expected a moderate raise around 0.8 bar, got ${estimate.targetPressure}`,
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
      previousPressure: 0.83,
      previousTemp: 0.6,
      previousPreviousCarbonation: 2.39,
      previousPreviousDateTimeMs: -48 * 3600000,
      hoursBetweenPreviousChecks: 48,
      previousHistoricalRatePerDay: 0,
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
  assert.equal(estimate.action, "raise");
  assert.ok(
    estimate.targetPressure >= 1.0 && estimate.targetPressure <= 1.2,
    `expected a modest but real raise around 1.0-1.2 bar, got ${estimate.targetPressure}`,
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

  const baseTransitions = transitionsFor(state, 0.002);
  const slowTransitions = baseTransitions.map((sample) => ({
    ...sample,
    kPerHour: 0.0002,
  }));
  const fastTransitions = baseTransitions.map((sample) => ({
    ...sample,
    kPerHour: 0.005,
  }));

  const slow = estimatePressureTargetV4({
    transitions: slowTransitions,
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 0.4,
  });
  const faster = estimatePressureTargetV4({
    transitions: fastTransitions,
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 0.4,
  });

  assert.ok(slow);
  assert.ok(faster);
  assert.ok(
    Math.abs(faster.targetPressure - slow.targetPressure) <= 0.5,
    "different fitted kinetics may fine-tune, but only within the bounded 0.5 bar search",
  );
  assert.ok(
    slow.targetPressure < 1.4 && faster.targetPressure < 1.4,
    "neither fitted k may create an extreme pressure target",
  );
  assert.notEqual(
    slow.predictedCarbonation,
    faster.predictedCarbonation,
    "k should still affect the forecast",
  );
});


test("same tank: lower carbonation never receives a lower pressure target", () => {
  const baseState: PressureV4DecisionState = {
    carbonation: 2.44,
    currentPressure: 0.8,
    currentTemp: 1.7,
    hoursSinceT0: 300,
    exposure: exposure(0.8, 300),
    cooling: cooling({
      hours: 255,
      currentTemp: 1.7,
      pressure: 0.8,
    }),
    carbonationTrend: {
      checksInPhase: 4,
      previousCarbonation: 2.44,
      previousDateTimeMs: 0,
      hoursSincePrevious: 48,
      deltaFromPrevious: 0,
      ratePerDay: 0,
      previousPressure: 0.8,
      previousTemp: 1.7,
      previousPreviousCarbonation: 2.44,
      previousPreviousDateTimeMs: -48 * 3600000,
      hoursBetweenPreviousChecks: 48,
      previousHistoricalRatePerDay: 0,
    },
  };

  const transitions = transitionsFor(baseState, 0.0025);

  const high = estimatePressureTargetV4({
    transitions,
    state: baseState,
    targetCarbonation: 2.5,
    equilibriumPressure: 0.72,
    coldReferenceTemperature: 1.7,
  });

  const low = estimatePressureTargetV4({
    transitions,
    state: {
      ...baseState,
      carbonation: 2.38,
      carbonationTrend: {
        ...baseState.carbonationTrend!,
        previousCarbonation: 2.38,
      },
    },
    targetCarbonation: 2.5,
    equilibriumPressure: 0.72,
    coldReferenceTemperature: 1.7,
  });

  assert.ok(high);
  assert.ok(low);
  assert.ok(
    low.targetPressure >= high.targetPressure,
    `lower carbonation got lower target: low=${low.targetPressure}, high=${high.targetPressure}`,
  );
});

test("forecast may fine-tune equilibrium-headroom target, but only modestly", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.38,
    currentPressure: 0.61,
    currentTemp: 0.4,
    hoursSinceT0: 1300,
    exposure: exposure(0.61, 1300),
    cooling: cooling({
      hours: 1240,
      currentTemp: 0.4,
      pressure: 0.61,
    }),
    carbonationTrend: {
      checksInPhase: 16,
      previousCarbonation: 2.39,
      previousDateTimeMs: 0,
      hoursSincePrevious: 48,
      deltaFromPrevious: -0.01,
      ratePerDay: -0.005,
    },
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.0024),
    state,
    targetCarbonation: 2.5,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 0.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "raise");
  assert.ok(
    estimate.targetPressure >= 0.95 && estimate.targetPressure <= 1.2,
    `expected forecast-driven refinement around 1.0-1.2 bar, got ${estimate.targetPressure}`,
  );
  assert.ok(
    estimate.predictedCarbonation > estimate.predictedCarbonationWithoutChange,
    "raising pressure should improve the two-day forecast",
  );
});


test("tank 2 style demo: 0.12 vol deficit gets a substantial raise when 48h forecast is still short", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.38,
    currentPressure: 0.8,
    currentTemp: 1.7,
    hoursSinceT0: 320,
    exposure: exposure(0.8, 320),
    cooling: cooling({
      hours: 255,
      currentTemp: 1.7,
      pressure: 0.8,
    }),
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.00159),
    state,
    targetCarbonation: 2.5,
    equilibriumPressure: 0.86,
    coldReferenceTemperature: 1.7,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "raise");
  assert.ok(
    estimate.targetPressure >= 1.3 && estimate.targetPressure <= 1.55,
    `expected a substantial raise around 1.4-1.5 bar, got ${estimate.targetPressure}`,
  );
  assert.ok(
    estimate.predictedCarbonation > estimate.predictedCarbonationWithoutChange,
  );
});

test("tank 6 style demo: forecast-short recommendation is raised beyond the old 0.95 bar result", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.36,
    currentPressure: 0.61,
    currentTemp: 0.4,
    hoursSinceT0: 1300,
    exposure: exposure(0.61, 1300),
    cooling: cooling({
      hours: 1240,
      currentTemp: 0.4,
      pressure: 0.61,
    }),
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.00237),
    state,
    targetCarbonation: 2.5,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 0.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "raise");
  assert.ok(
    estimate.targetPressure > 0.95,
    `old 0.95 bar target was knowingly short; got ${estimate.targetPressure}`,
  );
});

test("tank 15 style demo: slow historical k still gives a bounded moderate raise", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.36,
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

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.00038),
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.49,
    coldReferenceTemperature: 0.4,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "raise");
  assert.ok(
    estimate.targetPressure > state.currentPressure &&
      estimate.targetPressure < 1.0,
    `expected a bounded moderate raise below 1.0 bar, got ${estimate.targetPressure}`,
  );
});

test("tank 17 style demo: low carbonation cannot be HOLD while no-change stays below target", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.37,
    currentPressure: 0.83,
    currentTemp: 0.6,
    hoursSinceT0: 300,
    exposure: exposure(0.83, 300),
    cooling: cooling({
      hours: 255,
      currentTemp: 0.6,
      pressure: 0.83,
    }),
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.00076),
    state,
    targetCarbonation: 2.45,
    equilibriumPressure: 0.6,
    coldReferenceTemperature: 0.6,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "raise");
  assert.ok(
    estimate.targetPressure > state.currentPressure,
    `low carbonation with short forecast must not hold at ${estimate.targetPressure}`,
  );
});


test("stable V4 uses a ±0.02 vol target window, not ±0.04", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.47,
    currentPressure: 0.7,
    currentTemp: 1,
    hoursSinceT0: 300,
    exposure: exposure(0.7, 300),
    cooling: cooling({
      hours: 240,
      currentTemp: 1,
      pressure: 0.7,
    }),
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.004),
    state,
    targetCarbonation: 2.5,
    equilibriumPressure: 0.65,
    coldReferenceTemperature: 1,
  });

  assert.ok(estimate);
  assert.notEqual(
    estimate.action,
    "hold",
    "0.03 vol below target is outside the new ±0.02 window",
  );
  const forecastError = Math.abs(
    estimate.predictedCarbonation - estimate.targetCarbonation,
  );
  assert.ok(
    forecastError <= 0.02 ||
      estimate.decisionStatus === "pressure_adjust_and_recheck" ||
      estimate.pressureOnlyLikelyInsufficient,
    `stable V4 must either land within ±0.02, recommend pressure+recheck, or explicitly flag pressure-only insufficiency; got ${estimate.predictedCarbonation}`,
  );
});

test("early cooling keeps operational pressure logic even if forecast is outside ±0.02", () => {
  const earlyCooling = cooling({
    hours: 48,
    currentTemp: 6.8,
    pressure: 1.35,
    stillCooling: true,
    tempChange24h: -3,
  });
  const state: PressureV4DecisionState = {
    carbonation: 2.26,
    currentPressure: 1.44,
    currentTemp: 6.8,
    hoursSinceT0: 80,
    exposure: exposure(1.35, 80, 0.4),
    cooling: earlyCooling,
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.0015),
    state,
    targetCarbonation: 2.45,
    equilibriumPressure: 0.6,
    coldReferenceTemperature: 0.6,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "lower");
  assert.ok(
    estimate.targetPressure < state.currentPressure,
    "early cooling may recommend venting based on stored pressure/headroom",
  );
  if (!estimate.forecastInTargetWindow) {
    assert.equal(estimate.decisionStatus, "early_cooling_exception");
  }
});


test("early-cooling vent keeps extra head pressure when its own forecast is far below target", () => {
  const earlyCooling = cooling({
    hours: 64,
    currentTemp: 6.8,
    pressure: 1.35,
    stillCooling: true,
    tempChange24h: -3.5,
  });

  const state: PressureV4DecisionState = {
    carbonation: 2.27,
    currentPressure: 1.44,
    currentTemp: 6.8,
    hoursSinceT0: 96,
    exposure: exposure(1.35, 96, 0.45),
    cooling: earlyCooling,
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.00162),
    state,
    targetCarbonation: 2.45,
    equilibriumPressure: 0.44,
    coldReferenceTemperature: 0.5,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "lower");
  assert.ok(
    estimate.targetPressure >= 1.0 && estimate.targetPressure <= 1.15,
    `expected early-cooling safety correction near 1.1 bar, got ${estimate.targetPressure}`,
  );
  assert.ok(
    estimate.targetPressure < state.currentPressure,
    "the correction must still vent from the original closing pressure",
  );
});

test("early-cooling safety correction is bounded and never exceeds current pressure", () => {
  const earlyCooling = cooling({
    hours: 64,
    currentTemp: 4.5,
    pressure: 1.3,
    stillCooling: true,
    tempChange24h: -2.5,
  });

  const state: PressureV4DecisionState = {
    carbonation: 2.27,
    currentPressure: 1.37,
    currentTemp: 4.5,
    hoursSinceT0: 96,
    exposure: exposure(1.3, 96, 0.4),
    cooling: earlyCooling,
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.0012),
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.49,
    coldReferenceTemperature: 0.7,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "lower");
  assert.ok(
    estimate.targetPressure >= 1.0 && estimate.targetPressure <= 1.15,
    `expected a less aggressive vent near 1.0-1.1 bar, got ${estimate.targetPressure}`,
  );
  assert.ok(estimate.targetPressure <= state.currentPressure);
});


test("early cooling prefers a pressure that actually lands inside ±0.02 when available", () => {
  const earlyCooling = cooling({
    hours: 48,
    currentTemp: 5,
    pressure: 1.25,
    stillCooling: true,
    tempChange24h: -2,
  });
  const state: PressureV4DecisionState = {
    carbonation: 2.32,
    currentPressure: 1.3,
    currentTemp: 5,
    hoursSinceT0: 80,
    exposure: exposure(1.25, 80, 0.3),
    cooling: earlyCooling,
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.008),
    state,
    targetCarbonation: 2.45,
    equilibriumPressure: 0.7,
    coldReferenceTemperature: 1,
  });

  assert.ok(estimate);
  assert.ok(
    estimate.forecastInTargetWindow ||
      estimate.decisionStatus === "early_cooling_exception",
  );
  if (estimate.forecastInTargetWindow) {
    assert.ok(
      Math.abs(
        estimate.predictedCarbonation - estimate.targetCarbonation,
      ) <= 0.02,
    );
  }
});

test("venting engine estimates timed zero-bar opening from downward transitions", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.62,
    currentPressure: 0.8,
    currentTemp: 1,
    hoursSinceT0: 300,
    exposure: exposure(0.8, 300),
    cooling: cooling({
      hours: 240,
      currentTemp: 1,
      pressure: 0.8,
    }),
    carbonationTrend: null,
  };

  const downward = Array.from({ length: 10 }, (_, index) =>
    transition(index, {
      k: 0.02 + (index % 3) * 0.002,
      currentTemp: 1 + (index % 2) * 0.2,
      pressure: 0.05,
      hoursSinceT0: 280 + index * 4,
      startCarbonation: 2.6,
    }),
  ).map((sample) => ({
    ...sample,
    durationHours: 1,
    pressureMeanDuring: 0.05,
    endCarbonation: sample.startCarbonation - 0.06,
  }));

  const venting = estimateVentingDuration({
    transitions: downward,
    state,
    targetCarbonation: 2.5,
    ventPressureBar: 0,
    maxMinutes: 24 * 60,
  });

  assert.ok(venting);
  assert.ok(venting.durationMinutes > 0);
  assert.ok(venting.durationMinutes <= 24 * 60);
  assert.ok(
    venting.predictedCarbonationAtClose >= 2.48 &&
      venting.predictedCarbonationAtClose <= 2.52,
  );
  assert.ok(venting.supportCount >= 4);
});


test("tank 17 2.38->2.45 may refine to about 1.1 bar instead of declaring pressure-only insufficient", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.38,
    currentPressure: 0.83,
    currentTemp: 0.6,
    hoursSinceT0: 300,
    exposure: exposure(0.83, 300),
    cooling: cooling({
      hours: 255,
      currentTemp: 0.6,
      pressure: 0.83,
    }),
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.00123),
    state,
    targetCarbonation: 2.45,
    equilibriumPressure: 0.6,
    coldReferenceTemperature: 0.6,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "raise");
  assert.ok(
    estimate.targetPressure > state.currentPressure &&
      estimate.targetPressure <= 1.30,
    `expected a bounded ordinary-pressure correction, got ${estimate.targetPressure}`,
  );
  assert.notEqual(
    estimate.decisionStatus,
    "pressure_only_insufficient",
    "a modest low-carbonation correction should remain a pressure adjustment/recheck case",
  );
});


test("mild overcarbonation prefers a lower pressure setpoint, not timed venting semantics", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.45,
    currentPressure: 0.82,
    currentTemp: 1,
    hoursSinceT0: 300,
    exposure: exposure(0.82, 300),
    cooling: cooling({
      hours: 255,
      currentTemp: 1,
      pressure: 0.82,
    }),
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.001),
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.52,
    coldReferenceTemperature: 1,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "lower");
  assert.ok(
    estimate.targetPressure >= 0.45 && estimate.targetPressure <= 0.6,
    `expected about 0.5 bar for a mild excess, got ${estimate.targetPressure}`,
  );
  assert.notEqual(
    estimate.decisionStatus,
    "pressure_only_insufficient",
    "a mild excess should be handled as a pressure adjustment + recheck",
  );
});

test("mild undercarbonation may raise to about 1.1 bar instead of stopping at 0.95", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.35,
    currentPressure: 0.82,
    currentTemp: 1,
    hoursSinceT0: 300,
    exposure: exposure(0.82, 300),
    cooling: cooling({
      hours: 255,
      currentTemp: 1,
      pressure: 0.82,
    }),
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.00089),
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.52,
    coldReferenceTemperature: 1,
  });

  assert.ok(estimate);
  assert.equal(estimate.action, "raise");
  assert.ok(
    estimate.targetPressure >= 1.0 && estimate.targetPressure <= 1.15,
    `expected about 1.0-1.1 bar, got ${estimate.targetPressure}`,
  );
  assert.notEqual(
    estimate.decisionStatus,
    "pressure_only_insufficient",
  );
});

test("timed venting rejects long weak low-pressure estimates", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.45,
    currentPressure: 0.82,
    currentTemp: 1,
    hoursSinceT0: 300,
    exposure: exposure(0.82, 300),
    cooling: cooling({
      hours: 255,
      currentTemp: 1,
      pressure: 0.82,
    }),
    carbonationTrend: null,
  };

  const weakLowPressure = Array.from({ length: 8 }, (_, index) => {
    const sample = transition(index, {
      k: 0.001,
      currentTemp: 1,
      pressure: 0.05,
      hoursSinceT0: 280 + index,
      startCarbonation: 2.45,
    });
    return {
      ...sample,
      durationHours: 4,
      pressureMeanDuring: 0.05,
      endCarbonation: 2.44,
    };
  });

  const venting = estimateVentingDuration({
    transitions: weakLowPressure,
    state,
    targetCarbonation: 2.4,
    ventPressureBar: 0,
  });

  assert.equal(
    venting,
    null,
    "a multi-hour estimate should not become an automatic timed vent instruction",
  );
});


test("overcarbonation that still misses target at 0 bar becomes atmospheric venting, never negative pressure", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.65,
    currentPressure: 0.15,
    currentTemp: 1,
    hoursSinceT0: 300,
    exposure: exposure(0.15, 300),
    cooling: cooling({
      hours: 240,
      currentTemp: 1,
      pressure: 0.15,
    }),
    carbonationTrend: null,
  };

  const estimate = estimatePressureTargetV4({
    transitions: transitionsFor(state, 0.001),
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 1,
  });

  assert.ok(estimate);
  assert.equal(estimate.targetPressure, 0);
  assert.equal(estimate.requiresAtmosphericVenting, true);
  assert.equal(estimate.action, "lower");
  assert.ok(
    estimate.predictedCarbonation > estimate.targetWindowMax,
    "0 bar still leaves the 48h forecast above target, so the next operation must be venting",
  );
});


test("passive two-day history calibrates the no-change forecast", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.35,
    currentPressure: 0.8,
    currentTemp: 1,
    hoursSinceT0: 300,
    exposure: exposure(0.8, 300),
    cooling: cooling({
      hours: 250,
      currentTemp: 1,
      pressure: 0.8,
    }),
    carbonationTrend: null,
  };

  const transitions = transitionsFor(state, 0.0015);
  const base = estimatePressureTargetV4({
    transitions,
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.55,
    coldReferenceTemperature: 1,
  });
  assert.ok(base);

  const passiveSamples: PressureV4PassiveSample[] = Array.from(
    { length: 8 },
    (_, index) => ({
      batchId: `passive-${index}`,
      style: "test",
      sampleDateTimeMs: index * 100000,
      sampleDate: "2026-09-01",
      carbonationBefore: 2.35,
      currentPressure: 0.8,
      currentTemp: 1,
      hoursSinceT0: 300,
      exposure: exposure(0.8, 300),
      primaryOutcome: {
        carbonation: 2.45,
        dateTimeMs: index * 100000 + 48 * 3600000,
        calendarDaysAfterAction: 2,
      },
      carbonationDelta: 0.10,
      quality: "high",
    }),
  );

  const calibrated = estimatePressureTargetV4({
    passiveSamples,
    transitions,
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.55,
    coldReferenceTemperature: 1,
  });

  assert.ok(calibrated);
  assert.ok(calibrated.empiricalSupport >= 5);
  assert.ok(
    calibrated.predictedCarbonationWithoutChange >
      base.predictedCarbonationWithoutChange + 0.03,
    "passive history should materially lift the no-change forecast when real tanks kept absorbing CO2",
  );
});

test("pressure-action outcomes calibrate candidate forecasts instead of being ignored", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.34,
    currentPressure: 0.8,
    currentTemp: 1,
    hoursSinceT0: 300,
    exposure: exposure(0.8, 300),
    cooling: cooling({
      hours: 250,
      currentTemp: 1,
      pressure: 0.8,
    }),
    carbonationTrend: null,
  };

  const transitions = transitionsFor(state, 0.0015);
  const base = estimatePressureTargetV4({
    transitions,
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.55,
    coldReferenceTemperature: 1,
  });
  assert.ok(base);

  const samples: PressureV4Sample[] = Array.from(
    { length: 8 },
    (_, index) => ({
      batchId: `action-${index}`,
      style: "test",
      t0: {
        index: 0,
        dateTimeMs: 0,
        source: "explicit_close",
        pressure: 0.8,
        previousPressure: 0,
      },
      actionDateTimeMs: index * 100000,
      actionDate: "2026-09-01",
      carbonationBefore: 2.34,
      currentPressure: 0.8,
      targetPressure: 1.0,
      currentTemp: 1,
      hoursSinceT0: 300,
      exposure: exposure(0.8, 300),
      intermediateDay1: null,
      primaryOutcome: {
        carbonation: 2.45,
        dateTimeMs: index * 100000 + 48 * 3600000,
        calendarDaysAfterAction: 2,
      },
      carbonationDelta: 0.11,
      actionPressureDelta: 0.2,
      quality: "high",
    }),
  );

  const calibrated = estimatePressureTargetV4({
    samples,
    transitions,
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.55,
    coldReferenceTemperature: 1,
  });

  assert.ok(calibrated);
  assert.ok(calibrated.empiricalSupport >= 5);
  assert.ok(
    calibrated.targetPressure <= base.targetPressure,
    "when real pressure actions were more effective than physics alone, the calculator should not demand more pressure",
  );
});


test("real pressure-action slope overrides a tiny kinetic k when history is strong", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.25,
    currentPressure: 0.55,
    currentTemp: 1,
    hoursSinceT0: 450,
    exposure: exposure(0.55, 450),
    cooling: cooling({
      hours: 450,
      currentTemp: 1,
      pressure: 0.55,
    }),
    carbonationTrend: null,
  };

  const transitions = transitionsFor(state, 0.00007).slice(0, 4);
  const passiveSamples: PressureV4PassiveSample[] = Array.from(
    { length: 12 },
    (_, index) => ({
      batchId: `passive-strong-${index}`,
      style: "test",
      sampleDateTimeMs: index * 100000,
      sampleDate: "2026-09-01",
      carbonationBefore: 2.25,
      currentPressure: 0.55,
      currentTemp: 1,
      hoursSinceT0: 450,
      exposure: exposure(0.55, 450),
      primaryOutcome: {
        carbonation: 2.26,
        dateTimeMs: index * 100000 + 48 * 3600000,
        calendarDaysAfterAction: 2,
      },
      carbonationDelta: 0.01,
      quality: "high",
    }),
  );

  const actionDeltas = [0.15, 0.25, 0.35, 0.45];
  const samples: PressureV4Sample[] = Array.from(
    { length: 12 },
    (_, index) => {
      const actionPressureDelta = actionDeltas[index % actionDeltas.length];
      const carbonationDelta = 0.01 + actionPressureDelta * 0.32;
      return {
        batchId: `action-strong-${index}`,
        style: "test",
        t0: {
          index: 0,
          dateTimeMs: 0,
          source: "explicit_close",
          pressure: 0.55,
          previousPressure: 0,
        },
        actionDateTimeMs: index * 100000,
        actionDate: "2026-09-01",
        carbonationBefore: 2.25,
        currentPressure: 0.55,
        targetPressure: 0.55 + actionPressureDelta,
        currentTemp: 1,
        hoursSinceT0: 450,
        exposure: exposure(0.55, 450),
        intermediateDay1: null,
        primaryOutcome: {
          carbonation: 2.25 + carbonationDelta,
          dateTimeMs: index * 100000 + 48 * 3600000,
          calendarDaysAfterAction: 2,
        },
        carbonationDelta,
        actionPressureDelta,
        quality: "high",
      };
    },
  );

  const estimate = estimatePressureTargetV4({
    samples,
    passiveSamples,
    transitions,
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 1,
  });

  assert.ok(estimate);
  assert.equal(estimate.empiricalModelUsed, true);
  assert.ok(
    estimate.empiricalSlopeVolPerBar >= 0.2,
    `expected a meaningful learned pressure response, got ${estimate.empiricalSlopeVolPerBar}`,
  );
  assert.ok(
    estimate.predictedCarbonation - estimate.predictedCarbonationWithoutChange >= 0.04,
    "a strong pressure-action history must materially change the forecast even when kinetic k is tiny",
  );
  assert.notEqual(
    estimate.decisionStatus,
    "insufficient_response_evidence",
  );
});

test("tiny k without identifiable action slope suppresses automatic pressure setpoint", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.25,
    currentPressure: 0.55,
    currentTemp: 1,
    hoursSinceT0: 450,
    exposure: exposure(0.55, 450),
    cooling: cooling({
      hours: 450,
      currentTemp: 1,
      pressure: 0.55,
    }),
    carbonationTrend: null,
  };

  const transitions = transitionsFor(state, 0.00007).slice(0, 4);
  const passiveSamples: PressureV4PassiveSample[] = Array.from(
    { length: 24 },
    (_, index) => ({
      batchId: `passive-flat-${index}`,
      style: "test",
      sampleDateTimeMs: index * 100000,
      sampleDate: "2026-09-01",
      carbonationBefore: 2.25,
      currentPressure: 0.55,
      currentTemp: 1,
      hoursSinceT0: 450,
      exposure: exposure(0.55, 450),
      primaryOutcome: {
        carbonation: 2.25,
        dateTimeMs: index * 100000 + 48 * 3600000,
        calendarDaysAfterAction: 2,
      },
      carbonationDelta: 0,
      quality: "high",
    }),
  );

  const estimate = estimatePressureTargetV4({
    passiveSamples,
    transitions,
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 1,
  });

  assert.ok(estimate);
  assert.equal(estimate.empiricalSlopeVolPerBar, 0);
  assert.equal(estimate.empiricalModelUsed, false);
  assert.equal(
    estimate.decisionStatus,
    "insufficient_response_evidence",
    "a headroom prior must not become an automatic pressure recommendation when neither kinetics nor action history predicts a useful response",
  );
  assert.ok(
    estimate.predictedCarbonation - estimate.predictedCarbonationWithoutChange < 0.008,
  );
});


test("2.15 -> 2.40 must not present a pressure setpoint when it closes only a small fraction of the gap", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.15,
    currentPressure: 0.51,
    currentTemp: 1,
    hoursSinceT0: 450,
    exposure: exposure(0.51, 450),
    cooling: cooling({
      hours: 450,
      currentTemp: 1,
      pressure: 0.51,
    }),
    carbonationTrend: null,
  };

  const transitions = transitionsFor(state, 0.00007).slice(0, 4);

  const passiveSamples: PressureV4PassiveSample[] = Array.from(
    { length: 12 },
    (_, index) => ({
      batchId: `passive-weak-${index}`,
      style: "test",
      sampleDateTimeMs: index * 100000,
      sampleDate: "2026-09-01",
      carbonationBefore: 2.15,
      currentPressure: 0.51,
      currentTemp: 1,
      hoursSinceT0: 450,
      exposure: exposure(0.51, 450),
      primaryOutcome: {
        carbonation: 2.153,
        dateTimeMs: index * 100000 + 48 * 3600000,
        calendarDaysAfterAction: 2,
      },
      carbonationDelta: 0.003,
      quality: "high",
    }),
  );

  const actionDeltas = [0.15, 0.30, 0.45, 0.60];
  const samples: PressureV4Sample[] = Array.from(
    { length: 12 },
    (_, index) => {
      const actionPressureDelta = actionDeltas[index % actionDeltas.length];
      const carbonationDelta = 0.003 + actionPressureDelta * 0.025;
      return {
        batchId: `action-weak-${index}`,
        style: "test",
        t0: {
          index: 0,
          dateTimeMs: 0,
          source: "explicit_close",
          pressure: 0.51,
          previousPressure: 0,
        },
        actionDateTimeMs: index * 100000,
        actionDate: "2026-09-01",
        carbonationBefore: 2.15,
        currentPressure: 0.51,
        targetPressure: 0.51 + actionPressureDelta,
        currentTemp: 1,
        hoursSinceT0: 450,
        exposure: exposure(0.51, 450),
        intermediateDay1: null,
        primaryOutcome: {
          carbonation: 2.15 + carbonationDelta,
          dateTimeMs: index * 100000 + 48 * 3600000,
          calendarDaysAfterAction: 2,
        },
        carbonationDelta,
        actionPressureDelta,
        quality: "high",
      };
    },
  );

  const estimate = estimatePressureTargetV4({
    samples,
    passiveSamples,
    transitions,
    state,
    targetCarbonation: 2.4,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 1,
  });

  assert.ok(estimate);
  assert.equal(estimate.empiricalModelUsed, true);
  assert.ok(estimate.empiricalSlopeVolPerBar > 0);
  assert.ok(
    estimate.pressureActionEffectVol < 0.03,
    `expected the proposed pressure move to add only a few hundredths, got ${estimate.pressureActionEffectVol}`,
  );
  assert.ok(
    estimate.pressureGapClosedFraction < 0.2,
    `expected less than 20% of the remaining gap to close, got ${estimate.pressureGapClosedFraction}`,
  );
  assert.equal(
    estimate.decisionStatus,
    "pressure_only_insufficient",
    "a setpoint that leaves the forecast far from target must not be presented as a normal pressure recommendation",
  );
});


test("passive baseline stays robust when pressure-action outcomes are extreme", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.35,
    currentPressure: 0.61,
    currentTemp: 0.4,
    hoursSinceT0: 450,
    exposure: exposure(0.61, 450),
    cooling: cooling({
      hours: 450,
      currentTemp: 0.4,
      pressure: 0.61,
    }),
    carbonationTrend: null,
  };

  const passiveSamples: PressureV4PassiveSample[] = Array.from(
    { length: 12 },
    (_, index) => ({
      batchId: `passive-robust-${index}`,
      style: "test",
      sampleDateTimeMs: index * 100000,
      sampleDate: "2026-09-01",
      carbonationBefore: 2.35,
      currentPressure: 0.61,
      currentTemp: 0.4,
      hoursSinceT0: 450,
      exposure: exposure(0.61, 450),
      primaryOutcome: {
        carbonation: 2.37 + (index % 3) * 0.005,
        dateTimeMs: index * 100000 + 48 * 3600000,
        calendarDaysAfterAction: 2,
      },
      carbonationDelta: 0.02 + (index % 3) * 0.005,
      quality: "high",
    }),
  );

  const samples: PressureV4Sample[] = Array.from(
    { length: 12 },
    (_, index) => {
      const actionPressureDelta = [0.2, 0.35, 0.5][index % 3];
      return {
        batchId: `action-extreme-${index}`,
        style: "test",
        t0: {
          index: 0,
          dateTimeMs: 0,
          source: "explicit_close",
          pressure: 0.61,
          previousPressure: 0,
        },
        actionDateTimeMs: index * 100000,
        actionDate: "2026-09-01",
        carbonationBefore: 2.35,
        currentPressure: 0.61,
        targetPressure: 0.61 + actionPressureDelta,
        currentTemp: 0.4,
        hoursSinceT0: 450,
        exposure: exposure(0.61, 450),
        intermediateDay1: null,
        primaryOutcome: {
          carbonation: 3.5,
          dateTimeMs: index * 100000 + 48 * 3600000,
          calendarDaysAfterAction: 2,
        },
        carbonationDelta: 1.15,
        actionPressureDelta,
        quality: "high",
      };
    },
  );

  const estimate = estimatePressureTargetV4({
    samples,
    passiveSamples,
    transitions: transitionsFor(state, 0.00007).slice(0, 4),
    state,
    targetCarbonation: 2.5,
    equilibriumPressure: 0.5,
    coldReferenceTemperature: 0.4,
  });

  assert.ok(estimate);
  assert.ok(
    estimate.predictedCarbonationWithoutChange >= 2.36 &&
      estimate.predictedCarbonationWithoutChange <= 2.39,
    `passive no-change forecast must remain near robust passive drift, got ${estimate.predictedCarbonationWithoutChange}`,
  );
  assert.ok(
    estimate.predictedCarbonationWithoutChange < 2.6,
    "action outcomes must never drag the no-change baseline into an absurd whole-volume jump",
  );
});

test("2.27 -> 2.45 does not advertise a setpoint when the best forecast remains far short", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.27,
    currentPressure: 0.83,
    currentTemp: 0.6,
    hoursSinceT0: 450,
    exposure: exposure(0.83, 450),
    cooling: cooling({
      hours: 450,
      currentTemp: 0.6,
      pressure: 0.83,
    }),
    carbonationTrend: null,
  };

  const passiveSamples: PressureV4PassiveSample[] = Array.from(
    { length: 8 },
    (_, index) => ({
      batchId: `passive-227-${index}`,
      style: "test",
      sampleDateTimeMs: index * 100000,
      sampleDate: "2026-09-01",
      carbonationBefore: 2.27,
      currentPressure: 0.83,
      currentTemp: 0.6,
      hoursSinceT0: 450,
      exposure: exposure(0.83, 450),
      primaryOutcome: {
        carbonation: 2.29,
        dateTimeMs: index * 100000 + 48 * 3600000,
        calendarDaysAfterAction: 2,
      },
      carbonationDelta: 0.02,
      quality: "high",
    }),
  );

  const actionDeltas = [0.2, 0.35, 0.5, 0.65];
  const samples: PressureV4Sample[] = Array.from(
    { length: 12 },
    (_, index) => {
      const actionPressureDelta = actionDeltas[index % actionDeltas.length];
      const carbonationDelta = 0.02 + actionPressureDelta * 0.10;
      return {
        batchId: `action-227-${index}`,
        style: "test",
        t0: {
          index: 0,
          dateTimeMs: 0,
          source: "explicit_close",
          pressure: 0.83,
          previousPressure: 0,
        },
        actionDateTimeMs: index * 100000,
        actionDate: "2026-09-01",
        carbonationBefore: 2.27,
        currentPressure: 0.83,
        targetPressure: 0.83 + actionPressureDelta,
        currentTemp: 0.6,
        hoursSinceT0: 450,
        exposure: exposure(0.83, 450),
        intermediateDay1: null,
        primaryOutcome: {
          carbonation: 2.27 + carbonationDelta,
          dateTimeMs: index * 100000 + 48 * 3600000,
          calendarDaysAfterAction: 2,
        },
        carbonationDelta,
        actionPressureDelta,
        quality: "high",
      };
    },
  );

  const estimate = estimatePressureTargetV4({
    samples,
    passiveSamples,
    transitions: transitionsFor(state, 0.0004).slice(0, 4),
    state,
    targetCarbonation: 2.45,
    equilibriumPressure: 0.6,
    coldReferenceTemperature: 0.6,
  });

  assert.ok(estimate);
  assert.ok(
    estimate.predictedCarbonation < 2.41,
    `synthetic weak-response case should remain materially short, got ${estimate.predictedCarbonation}`,
  );
  assert.equal(
    estimate.decisionStatus,
    "pressure_only_insufficient",
    "a far-short forecast must not be presented as an ordinary pressure setpoint",
  );
});

test("active cooling keeps the stored-pressure decision separate from stable 48h empirical learning", () => {
  const state: PressureV4DecisionState = {
    carbonation: 2.26,
    currentPressure: 1.44,
    currentTemp: 6.8,
    hoursSinceT0: 80,
    exposure: exposure(1.35, 80, 0.4),
    cooling: cooling({
      hours: 48,
      currentTemp: 6.8,
      pressure: 1.35,
      stillCooling: true,
      tempChange24h: -3,
    }),
    carbonationTrend: null,
  };

  const misleadingPassive: PressureV4PassiveSample[] = Array.from(
    { length: 12 },
    (_, index) => ({
      batchId: `passive-wrong-phase-${index}`,
      style: "test",
      sampleDateTimeMs: index * 100000,
      sampleDate: "2026-09-01",
      carbonationBefore: 2.26,
      currentPressure: 1.44,
      currentTemp: 1,
      hoursSinceT0: 400,
      exposure: exposure(1.44, 400),
      primaryOutcome: {
        carbonation: 3.2,
        dateTimeMs: index * 100000 + 48 * 3600000,
        calendarDaysAfterAction: 2,
      },
      carbonationDelta: 0.94,
      quality: "high",
    }),
  );

  const estimate = estimatePressureTargetV4({
    passiveSamples: misleadingPassive,
    transitions: transitionsFor(state, 0.0015),
    state,
    targetCarbonation: 2.45,
    equilibriumPressure: 0.6,
    coldReferenceTemperature: 0.6,
  });

  assert.ok(estimate);
  assert.equal(estimate.decisionStatus, "early_cooling_exception");
  assert.equal(estimate.action, "lower");
  assert.ok(
    estimate.targetPressure >= 1.0 && estimate.targetPressure <= 1.15,
    `expected early-cooling stored-pressure target near 1.1 bar, got ${estimate.targetPressure}`,
  );
  assert.equal(
    estimate.empiricalPassiveSupport,
    0,
    "stable passive history must not drive an active-cooling decision",
  );
});
