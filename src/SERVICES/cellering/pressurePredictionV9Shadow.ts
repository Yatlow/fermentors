import {
  deleteField,
  doc,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import type {
  Fermentor,
  ReadingToSend,
} from "../../App";
import { db } from "../../firebase";
import type { SpecChart } from "../getAndPost/getSpecsFromFb";
import type { Measurement } from "./calculateCelleringRecomendations";
import {
  estimatePressureTargetV9,
  simulateV9ActionForecast,
  type PressureV9Estimate,
} from "./pressurePredictionV9Physics";
import {
  getColdReferenceTemperatureV4,
  getPressurePredictionModelV4,
  type PressurePredictionModelV4,
} from "./pressurePredictionV4Model";

type ShadowStateQuality =
  | "same_submission"
  | "same_day_merged"
  | "insufficient";

export type PressureV9ShadowSnapshot = {
  version: 1;
  modelVersion: 9;
  batchNumber: string;
  tankNumber: number;
  beerStyle: string;
  measurementId: string;
  stateQuality: ShadowStateQuality;
  confidence: "high" | "medium" | "low";
  currentCarbonation: number;
  currentPressure: number;
  currentTemperature: number;
  targetCarbonation: number;
  targetToleranceVol: number;
  beerVolumeLiters: number;
  kPerHour: number;
  finalTemperature: number;
  coolingHoursRemaining: number;
  action: PressureV9Estimate["action"];
  targetPressure: number | null;
  holdFinalCarbonation: number | null;
  holdFinalPressure: number | null;
  target48hCarbonation: number | null;
  target48hPressure: number | null;
  target72hCarbonation: number | null;
  target72hPressure: number | null;
  target96hCarbonation: number | null;
  target96hPressure: number | null;
  geometrySensitivityWidthBar: number | null;
  expectedFutureOperationalLossBar: number;
  operatorActionNote: string | null;
  createdAt: unknown;
  outcome?: PressureV9ShadowOutcome;
};

export type PressureV9ShadowOutcome = {
  evaluatedAtMeasurementId: string;
  elapsedHours: number | null;
  cleanInterval: boolean;
  contaminationReason: string | null;
  scorable: boolean;
  scoringMode:
    | "hold"
    | "operator_pressure_action"
    | "unscorable";
  appliedPressureForForecast: number | null;
  forecastHorizonHours: number | null;
  predictedCarbonation: number | null;
  actualCarbonation: number;
  carbonationAbsError: number | null;
  predictedPressure: number | null;
  actualPressure: number;
  pressureAbsError: number | null;
};

function finite(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }
  const number = Number(
    String(value).replace(",", "."),
  );
  return Number.isFinite(number)
    ? number
    : null;
}

function normalizeStyle(value: unknown): string {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase()
      .split(/\s+/)[0] || "other"
  );
}

function median(values: number[]): number | null {
  const clean = values
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b);
  if (!clean.length) return null;

  const middle = Math.floor(clean.length / 2);
  return clean.length % 2
    ? clean[middle]
    : (
        clean[middle - 1] +
        clean[middle]
      ) / 2;
}

function v9KFromModel(
  model: PressurePredictionModelV4 | null,
  batchNumber: string,
): number {
  if (!model) return 0.0025;

  const usable = model.transitions
    .filter(
      (sample) =>
        sample.quality !== "low" &&
        String(sample.batchId ?? "") !==
          batchNumber &&
        Number.isFinite(
          Number(sample.kPerHour),
        ) &&
        Number(sample.kPerHour) > 0,
    )
    .map((sample) =>
      Number(sample.kPerHour),
    );

  return median(usable) ?? 0.0025;
}

function measurementTimeMs(
  id: unknown,
): number | null {
  const text = String(id ?? "").trim();
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})_(\d{1,2})(\d{2})$/,
  );
  if (!match) return null;

  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    hour,
    minute,
    0,
    0,
  ).getTime();
}

function temperatureChange24h(
  measurements: Measurement[],
): number | null {
  const rows = measurements
    .map((row) => ({
      timeMs: measurementTimeMs(row.id),
      temp: finite(row.temp),
    }))
    .filter(
      (
        row,
      ): row is {
        timeMs: number;
        temp: number;
      } =>
        row.timeMs !== null &&
        row.temp !== null,
    )
    .sort((a, b) => a.timeMs - b.timeMs);

  if (rows.length < 2) return null;

  const latest = rows[rows.length - 1];
  for (
    let index = rows.length - 2;
    index >= 0;
    index -= 1
  ) {
    const previous = rows[index];
    const hours =
      (
        latest.timeMs -
        previous.timeMs
      ) / 3600000;

    if (hours < 8) continue;
    if (hours > 36) break;

    return (
      (latest.temp - previous.temp) *
      24 /
      hours
    );
  }

  return null;
}

function operatorActionNote(
  reading: ReadingToSend,
): string | null {
  const note = String(
    reading.notes ?? "",
  ).trim();
  if (!note) return null;

  if (
    /(?:לחץ|גיזוז מלמטה|שמרים|שמרי)/i.test(
      note,
    )
  ) {
    return note;
  }

  return null;
}

function stateFromReading(args: {
  reading: ReadingToSend;
  measurements: Measurement[];
}): {
  carbonation: number;
  pressure: number;
  temperature: number;
  quality: ShadowStateQuality;
} | null {
  const carbonation =
    finite(args.reading.carbonation);
  if (carbonation === null) return null;

  const directPressure =
    finite(args.reading.pressure);
  const directTemperature =
    finite(args.reading.temp);

  if (
    directPressure !== null &&
    directTemperature !== null
  ) {
    return {
      carbonation,
      pressure: directPressure,
      temperature: directTemperature,
      quality: "same_submission",
    };
  }

  const id = String(
    args.reading.id ?? "",
  );
  const day = id.slice(0, 10);
  const sameDay = args.measurements
    .filter(
      (row) =>
        String(row.id ?? "").slice(0, 10) ===
        day,
    )
    .slice()
    .sort((a, b) =>
      String(a.id ?? "").localeCompare(
        String(b.id ?? ""),
      ),
    )
    .at(-1);

  const mergedPressure =
    directPressure ??
    finite(sameDay?.pressure);
  const mergedTemperature =
    directTemperature ??
    finite(sameDay?.temp);

  if (
    mergedPressure === null ||
    mergedTemperature === null
  ) {
    return null;
  }

  return {
    carbonation,
    pressure: mergedPressure,
    temperature: mergedTemperature,
    quality: "same_day_merged",
  };
}

function confidenceFor(args: {
  stateQuality: ShadowStateQuality;
  estimate: PressureV9Estimate;
}): "high" | "medium" | "low" {
  if (
    args.estimate.action ===
      "insufficient_geometry" ||
    args.estimate.action ===
      "outside_operational_range"
  ) {
    return "low";
  }

  const sensitivity =
    args.estimate
      .geometrySensitivityWidthBar;

  if (
    args.stateQuality ===
      "same_submission" &&
    sensitivity !== null &&
    sensitivity <= 0.2
  ) {
    return "high";
  }

  if (
    args.stateQuality !==
      "insufficient" &&
    (
      sensitivity === null ||
      sensitivity <= 0.3
    )
  ) {
    return "medium";
  }

  return "low";
}

function interventionBetween(
  measurements: Measurement[],
  fromId: string,
  toId: string,
): string | null {
  const rows = measurements
    .filter((row) => {
      const id = String(row.id ?? "");
      return (
        id > fromId &&
        id < toId
      );
    });

  for (const row of rows) {
    const note = String(
      row.notes ?? "",
    );
    if (/גיזוז מלמטה/i.test(note)) {
      return "bottom_carbonation";
    }
    if (/שמרים|שמרי/i.test(note)) {
      return "yeast_drop";
    }
    if (
      /(?:העל|הורד|להעלות|להוריד|שחרור|שחרר|שינוי|כיוון|ויסות|ווסת|פתיחת|פתח)[^|]{0,30}לחץ/i.test(
        note,
      ) ||
      /לחץ\s*(?:ל|על|עד|->|=|:)\s*\d/i.test(
        note,
      )
    ) {
      return "pressure_action";
    }
  }

  return null;
}

function operatorPressureTargetFromNote(
  noteValue: string | null,
): number | null {
  const note = String(noteValue ?? "")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  if (!note) return null;
  if (
    /גיזוז מלמטה|שמרים|שמרי/i.test(note)
  ) {
    return null;
  }

  const patterns = [
    /(?:העל(?:את|ה)|להעלות|הוספת|הורד(?:ת|ה)|להוריד|הנמכ(?:ת|ה)|שחרור|שחרר|פריק(?:ת|ה)|הוצאת|פתיחת|פתח|שינוי|שינה|כיוון|כוונון|ויסות|ווסת)[^\d]{0,24}(?:לחץ[^\d]{0,12})?(?:ל|על|עד|->|=|:)?\s*(-?\d+(?:[.,]\d+)?)/gi,
    /לחץ\s*(?:ל|על|עד|->|=|:)\s*(-?\d+(?:[.,]\d+)?)/gi,
  ];

  const candidates: number[] = [];
  for (const pattern of patterns) {
    for (const match of note.matchAll(pattern)) {
      const value = finite(match[1]);
      if (
        value !== null &&
        value >= 0 &&
        value <= 1.9
      ) {
        candidates.push(value);
      }
    }
  }

  return candidates.length
    ? candidates[candidates.length - 1]
    : null;
}

function noteContainsPressureAction(
  noteValue: string | null,
): boolean {
  const note = String(noteValue ?? "");
  if (!note) return false;
  if (
    /גיזוז מלמטה|שמרים|שמרי/i.test(note)
  ) {
    return false;
  }
  return (
    /(?:העל|הורד|להעלות|להוריד|שחרור|שחרר|שינוי|כיוון|ויסות|ווסת|פתיחת|פתח)[^|]{0,30}לחץ/i.test(
      note,
    ) ||
    /לחץ\s*(?:ל|על|עד|->|=|:)\s*\d/i.test(
      note,
    )
  );
}

function makeOutcome(args: {
  previous: PressureV9ShadowSnapshot;
  currentId: string;
  currentCarbonation: number;
  currentPressure: number;
  measurements: Measurement[];
}): PressureV9ShadowOutcome {
  const previousTime =
    measurementTimeMs(
      args.previous.measurementId,
    );
  const currentTime =
    measurementTimeMs(args.currentId);
  const elapsedHours =
    previousTime !== null &&
    currentTime !== null
      ? (
          currentTime -
          previousTime
        ) / 3600000
      : null;

  let contaminationReason =
    interventionBetween(
      args.measurements,
      args.previous.measurementId,
      args.currentId,
    );

  const startNote =
    args.previous.operatorActionNote;
  let scoringMode:
    PressureV9ShadowOutcome["scoringMode"] =
    "hold";
  let appliedPressure =
    args.previous.currentPressure;

  if (
    /גיזוז מלמטה/i.test(
      String(startNote ?? ""),
    )
  ) {
    contaminationReason =
      contaminationReason ??
      "bottom_carbonation_at_start";
  } else if (
    /שמרים|שמרי/i.test(
      String(startNote ?? ""),
    )
  ) {
    contaminationReason =
      contaminationReason ??
      "yeast_drop_at_start";
  } else {
    const operatorTarget =
      operatorPressureTargetFromNote(
        startNote,
      );
    if (operatorTarget !== null) {
      scoringMode =
        "operator_pressure_action";
      appliedPressure = operatorTarget;
    } else if (
      noteContainsPressureAction(startNote)
    ) {
      contaminationReason =
        contaminationReason ??
        "ambiguous_pressure_action_at_start";
    }
  }

  const scorable =
    contaminationReason === null &&
    elapsedHours !== null &&
    elapsedHours > 0 &&
    elapsedHours <= 168;

  const forecast =
    scorable
      ? simulateV9ActionForecast({
          tankNumber:
            args.previous.tankNumber,
          beerVolumeLiters:
            args.previous.beerVolumeLiters,
          startCarbonation:
            args.previous.currentCarbonation,
          startPressure:
            args.previous.currentPressure,
          startTemperature:
            args.previous.currentTemperature,
          setPressure:
            appliedPressure,
          finalTemperature:
            args.previous.finalTemperature,
          coolingHours:
            args.previous.coolingHoursRemaining,
          kPerHour:
            args.previous.kPerHour,
          futureOperationalLossBar:
            args.previous
              .expectedFutureOperationalLossBar,
          hours: Math.max(
            1,
            Math.ceil(elapsedHours ?? 1),
          ),
        })
      : null;

  const point =
    forecast && elapsedHours !== null
      ? forecast.points
          .slice()
          .sort(
            (a, b) =>
              Math.abs(
                a.hour - elapsedHours,
              ) -
              Math.abs(
                b.hour - elapsedHours,
              ),
          )[0] ?? null
      : null;

  return {
    evaluatedAtMeasurementId:
      args.currentId,
    elapsedHours,
    cleanInterval:
      contaminationReason === null,
    contaminationReason,
    scorable:
      scorable && point !== null,
    scoringMode:
      scorable && point !== null
        ? scoringMode
        : "unscorable",
    appliedPressureForForecast:
      scorable && point !== null
        ? appliedPressure
        : null,
    forecastHorizonHours:
      point?.hour ?? null,
    predictedCarbonation:
      point?.carbonation ?? null,
    actualCarbonation:
      args.currentCarbonation,
    carbonationAbsError:
      point
        ? Math.abs(
            point.carbonation -
            args.currentCarbonation,
          )
        : null,
    predictedPressure:
      point?.pressure ?? null,
    actualPressure:
      args.currentPressure,
    pressureAbsError:
      point
        ? Math.abs(
            point.pressure -
            args.currentPressure,
          )
        : null,
  };
}

export async function recordPressureV9Shadow(args: {
  tank: Fermentor;
  reading: ReadingToSend;
  measurements: Measurement[];
  specs: SpecChart;
}): Promise<PressureV9ShadowSnapshot | null> {
  const batchNumber = String(
    args.tank.batchNumber ?? "",
  )
    .replace("#", "")
    .trim();
  const tankNumber =
    finite(args.tank.tankNumber);
  const beerVolumeLiters =
    finite(args.tank.beerVolume);
  const measurementId = String(
    args.reading.id ?? "",
  ).trim();

  if (
    !batchNumber ||
    tankNumber === null ||
    beerVolumeLiters === null ||
    beerVolumeLiters <= 0 ||
    !measurementId
  ) {
    return null;
  }

  const state = stateFromReading({
    reading: args.reading,
    measurements: args.measurements,
  });
  if (
    !state ||
    state.temperature > 9
  ) {
    return null;
  }

  const style = normalizeStyle(
    args.tank.beerStyle,
  );
  const targetCarbonation = finite(
    args.specs.carbonation?.[style] ??
      args.specs.carbonation?.other,
  );
  if (targetCarbonation === null) {
    return null;
  }

  const model =
    await getPressurePredictionModelV4(
      args.tank.beerStyle,
    );
  const kPerHour = v9KFromModel(
    model,
    batchNumber,
  );
  const finalTemperature =
    (
      model
        ? getColdReferenceTemperatureV4(
            model,
          )
        : null
    ) ?? 0.5;

  const estimate =
    estimatePressureTargetV9({
      tankNumber,
      beerVolumeLiters,
      currentCarbonation:
        state.carbonation,
      currentPressure:
        state.pressure,
      currentTemperature:
        state.temperature,
      targetCarbonation,
      targetToleranceVol:
        finite(
          args.specs.tolorances
            .carbonation,
        ) ?? 0.04,
      finalTemperature,
      kPerHour,
      tempChange24h:
        temperatureChange24h(
          args.measurements,
        ),
      measurements:
        args.measurements,
    });
  if (!estimate) return null;

  const snapshot: PressureV9ShadowSnapshot = {
    version: 1,
    modelVersion: 9,
    batchNumber,
    tankNumber,
    beerStyle: String(
      args.tank.beerStyle ?? "",
    ),
    measurementId,
    stateQuality: state.quality,
    confidence: confidenceFor({
      stateQuality: state.quality,
      estimate,
    }),
    currentCarbonation:
      state.carbonation,
    currentPressure:
      state.pressure,
    currentTemperature:
      state.temperature,
    targetCarbonation,
    targetToleranceVol:
      finite(
        args.specs.tolorances
          .carbonation,
      ) ?? 0.04,
    beerVolumeLiters,
    kPerHour,
    finalTemperature,
    coolingHoursRemaining:
      estimate.coolingHoursRemaining,
    action: estimate.action,
    targetPressure:
      estimate.targetPressure,
    holdFinalCarbonation:
      estimate.holdFinalCarbonation,
    holdFinalPressure:
      estimate.holdFinalPressure,
    target48hCarbonation:
      estimate.target48hCarbonation,
    target48hPressure:
      estimate.target48hPressure,
    target72hCarbonation:
      estimate.target72hCarbonation,
    target72hPressure:
      estimate.target72hPressure,
    target96hCarbonation:
      estimate.target96hCarbonation,
    target96hPressure:
      estimate.target96hPressure,
    geometrySensitivityWidthBar:
      estimate.geometrySensitivityWidthBar,
    expectedFutureOperationalLossBar:
      estimate.expectedFutureOperationalLossBar,
    operatorActionNote:
      operatorActionNote(
        args.reading,
      ),
    createdAt: serverTimestamp(),
  };

  // Store shadow history on the fermentor document, not brews/{batch}.
  // The GAS fermentor sync uses an explicit updateMask and therefore preserves
  // unknown fields such as v9Shadow. The brew uploader replaces the parent brew
  // document and could otherwise erase experimental history.
  const fermentorRef = doc(
    db,
    "fermentors",
    String(args.tank.id),
  );
  const existing =
    (
      args.tank.v9Shadow &&
      typeof args.tank.v9Shadow === "object" &&
      !Array.isArray(args.tank.v9Shadow)
        ? args.tank.v9Shadow
        : {}
    ) as Record<
      string,
      PressureV9ShadowSnapshot
    >;

  const shadowKey =
    `${batchNumber}__${measurementId}`;

  const previousEntry =
    Object.entries(existing)
      .filter(
        ([key, value]) =>
          key !== shadowKey &&
          value &&
          value.batchNumber ===
            batchNumber &&
          !value.outcome &&
          String(
            value.measurementId ?? "",
          ) < measurementId,
      )
      .sort((a, b) =>
        String(
          b[1].measurementId ?? "",
        ).localeCompare(
          String(
            a[1].measurementId ?? "",
          ),
        ),
      )[0];

  const patch: Record<string, unknown> = {
    [`v9Shadow.${shadowKey}`]:
      snapshot,
  };

  if (previousEntry) {
    const [
      previousKey,
      previous,
    ] = previousEntry;

    patch[
      `v9Shadow.${previousKey}.outcome`
    ] = makeOutcome({
      previous,
      currentId: measurementId,
      currentCarbonation:
        state.carbonation,
      currentPressure:
        state.pressure,
      measurements:
        args.measurements,
    });
  }

  // Bound document growth. 120 snapshots is far more than needed for the
  // prospective reliability checkpoint and keeps each fermentor safely small.
  const orderedKeys = Object.entries(existing)
    .sort((a, b) =>
      String(
        a[1]?.measurementId ?? a[0],
      ).localeCompare(
        String(
          b[1]?.measurementId ?? b[0],
        ),
      ),
    )
    .map(([key]) => key);
  const overflow = Math.max(
    0,
    orderedKeys.length + 1 - 120,
  );
  for (
    const key of orderedKeys.slice(
      0,
      overflow,
    )
  ) {
    patch[
      `v9Shadow.${key}`
    ] = deleteField();
  }

  await updateDoc(
    fermentorRef,
    patch,
  );

  return snapshot;
}
