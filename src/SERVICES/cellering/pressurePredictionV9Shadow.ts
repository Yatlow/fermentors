import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import type {
  Fermentor,
  ReadingToSend,
} from "../../App";
import { db } from "../../firebase";
import type { SpecChart } from "../getAndPost/getSpecsFromFb";
import type { Measurement } from "./calculateCelleringRecomendations";
import {
  simulateV9ActionForecast,
  type PressureV9Estimate,
} from "./pressurePredictionV9Physics";
import { estimatePressureV9ForTank } from "./pressurePredictionV9Live";

type ShadowStateQuality =
  | "same_submission"
  | "same_day_merged"
  | "insufficient";

export type PressureV9ShadowSnapshot = {
  version: 1;
  modelVersion: 9;
  modelConfigVersion: string;
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
  actualActions?: PressureV9ShadowAction[];
  createdAt: unknown;
  outcome?: PressureV9ShadowOutcome;
};

export type PressureV9ShadowAction = {
  measurementId: string;
  kind:
    | "pressure"
    | "bottom_carbonation"
    | "yeast_drop"
    | "ambiguous";
  targetPressure: number | null;
  note: string;
  delayHoursFromCarbonation: number | null;
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
  ignoredIds: Set<string> = new Set(),
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
    const rowId = String(row.id ?? "");
    if (ignoredIds.has(rowId)) continue;

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

function classifyActionNote(
  noteValue: unknown,
): {
  kind: PressureV9ShadowAction["kind"];
  targetPressure: number | null;
} | null {
  const note = String(noteValue ?? "").trim();
  if (!note) return null;

  if (/גיזוז מלמטה/i.test(note)) {
    return {
      kind: "bottom_carbonation",
      targetPressure: operatorPressureTargetFromNote(note),
    };
  }

  if (/שמרים|שמרי/i.test(note)) {
    return {
      kind: "yeast_drop",
      targetPressure: null,
    };
  }

  const targetPressure =
    operatorPressureTargetFromNote(note);
  if (targetPressure !== null) {
    return {
      kind: "pressure",
      targetPressure,
    };
  }

  if (noteContainsPressureAction(note)) {
    return {
      kind: "ambiguous",
      targetPressure: null,
    };
  }

  return null;
}

function actionDelayHours(
  carbonationMeasurementId: string,
  actionMeasurementId: string,
): number | null {
  const from =
    measurementTimeMs(
      carbonationMeasurementId,
    );
  const to =
    measurementTimeMs(
      actionMeasurementId,
    );
  if (from === null || to === null) {
    return null;
  }
  return Math.max(
    0,
    (to - from) / 3600000,
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

  const recordedActions =
    args.previous.actualActions ?? [];
  const ignoredActionIds = new Set(
    recordedActions.map(
      (action) => action.measurementId,
    ),
  );

  let contaminationReason =
    interventionBetween(
      args.measurements,
      args.previous.measurementId,
      args.currentId,
      ignoredActionIds,
    );

  let scoringMode:
    PressureV9ShadowOutcome["scoringMode"] =
    "hold";
  let appliedPressure =
    args.previous.currentPressure;
  let appliedDelayHours = 0;

  if (recordedActions.length > 0) {
    const disruptive = recordedActions.find(
      (action) =>
        action.kind === "bottom_carbonation" ||
        action.kind === "yeast_drop" ||
        action.kind === "ambiguous",
    );

    const pressureActions = recordedActions.filter(
      (action) =>
        action.kind === "pressure" &&
        action.targetPressure !== null,
    );

    if (disruptive) {
      contaminationReason =
        contaminationReason ??
        disruptive.kind;
    } else if (pressureActions.length > 1) {
      contaminationReason =
        contaminationReason ??
        "multiple_pressure_actions";
    } else if (pressureActions.length === 1) {
      const action = pressureActions[0];
      scoringMode =
        "operator_pressure_action";
      appliedPressure =
        action.targetPressure!;
      const delay =
        action.delayHoursFromCarbonation ??
        actionDelayHours(
          args.previous.measurementId,
          action.measurementId,
        );
      if (delay === null) {
        contaminationReason =
          contaminationReason ??
          "unknown_action_time";
      } else {
        appliedDelayHours = delay;
      }
    }
  } else {
    // Backwards compatibility for snapshots created before delayed action
    // linking was introduced.
    const startNote =
      args.previous.operatorActionNote;

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
  }

  const scorable =
    contaminationReason === null &&
    elapsedHours !== null &&
    elapsedHours > 0 &&
    elapsedHours <= 168 &&
    appliedDelayHours <= elapsedHours;

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
          actionDelayHours:
            scoringMode ===
              "operator_pressure_action"
              ? appliedDelayHours
              : 0,
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


export async function recordPressureV9ShadowAction(args: {
  tank: Fermentor;
  reading: ReadingToSend;
}): Promise<boolean> {
  const batchNumber = String(
    args.tank.batchNumber ?? "",
  )
    .replace("#", "")
    .trim();
  const measurementId = String(
    args.reading.id ?? "",
  ).trim();
  const note = String(
    args.reading.notes ?? "",
  ).trim();

  if (
    !batchNumber ||
    !measurementId ||
    !note
  ) {
    return false;
  }

  const classified =
    classifyActionNote(note);
  if (!classified) return false;

  const tankNumber =
    finite(args.tank.tankNumber);
  if (tankNumber === null) return false;

  const shadowRef = doc(
    db,
    "scheduledCellarRecommendations",
    `v9-shadow-${String(args.tank.id)}`,
  );
  const shadowDoc = await getDoc(shadowRef);
  if (!shadowDoc.exists()) {
    return false;
  }

  const rawEntries =
    shadowDoc.data().entries;
  if (
    !rawEntries ||
    typeof rawEntries !== "object" ||
    Array.isArray(rawEntries)
  ) {
    return false;
  }

  const entries =
    rawEntries as Record<
      string,
      PressureV9ShadowSnapshot
    >;

  const openEntry =
    Object.entries(entries)
      .filter(
        ([, value]) =>
          value &&
          value.batchNumber ===
            batchNumber &&
          !value.outcome &&
          String(
            value.measurementId ?? "",
          ) <= measurementId,
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

  if (!openEntry) return false;

  const [entryKey, snapshot] =
    openEntry;
  const previousActions =
    snapshot.actualActions ?? [];

  if (
    previousActions.some(
      (action) =>
        action.measurementId ===
          measurementId &&
        action.note === note,
    )
  ) {
    return true;
  }

  const action: PressureV9ShadowAction = {
    measurementId,
    kind: classified.kind,
    targetPressure:
      classified.targetPressure,
    note,
    delayHoursFromCarbonation:
      actionDelayHours(
        snapshot.measurementId,
        measurementId,
      ),
  };

  const nextEntries = {
    ...entries,
    [entryKey]: {
      ...snapshot,
      actualActions: [
        ...previousActions,
        action,
      ],
    },
  };

  await setDoc(shadowRef, {
    kind: "v9_shadow",
    status: "v9_shadow",
    tankId: String(args.tank.id),
    tankNumber,
    updatedAt: serverTimestamp(),
    entries: nextEntries,
  });

  return true;
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

  const live =
    await estimatePressureV9ForTank({
      tank: args.tank,
      measurements: args.measurements,
      specs: args.specs,
      carbonation: state.carbonation,
      pressure: state.pressure,
      temperature: state.temperature,
    });
  if (!live) return null;

  const {
    estimate,
    targetCarbonation,
    targetToleranceVol,
    finalTemperature,
    kPerHour,
    modelConfigVersion,
  } = live;

  const snapshot: PressureV9ShadowSnapshot = {
    version: 1,
    modelVersion: 9,
    modelConfigVersion,
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
    targetToleranceVol,
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

  // Dedicated state document inside an already-authorized collection.
  // status is deliberately NOT "active", so the scheduled-recommendations
  // listener never receives these experimental documents. This avoids changing
  // Firestore rules and also avoids fields that the GAS fermentor/brew sync
  // might overwrite or compare on every cycle.
  const shadowRef = doc(
    db,
    "scheduledCellarRecommendations",
    `v9-shadow-${String(args.tank.id)}`,
  );
  const shadowDoc = await getDoc(shadowRef);
  const existing =
    shadowDoc.exists() &&
    shadowDoc.data().entries &&
    typeof shadowDoc.data().entries === "object" &&
    !Array.isArray(shadowDoc.data().entries)
      ? shadowDoc.data().entries as Record<
          string,
          PressureV9ShadowSnapshot
        >
      : {};

  const shadowKey =
    `${batchNumber}__${measurementId}`;

  const nextEntries: Record<
    string,
    PressureV9ShadowSnapshot
  > = {
    ...existing,
    [shadowKey]: snapshot,
  };

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

  if (previousEntry) {
    const [
      previousKey,
      previous,
    ] = previousEntry;

    nextEntries[previousKey] = {
      ...previous,
      outcome: makeOutcome({
        previous,
        currentId: measurementId,
        currentCarbonation:
          state.carbonation,
        currentPressure:
          state.pressure,
        measurements:
          args.measurements,
      }),
    };
  }

  // Bound document growth. Keep the most recent 120 snapshots per tank.
  const ordered = Object.entries(
    nextEntries,
  ).sort((a, b) =>
    String(
      a[1]?.measurementId ?? a[0],
    ).localeCompare(
      String(
        b[1]?.measurementId ?? b[0],
      ),
    ),
  );
  const boundedEntries = Object.fromEntries(
    ordered.slice(-120),
  );

  await setDoc(shadowRef, {
    kind: "v9_shadow",
    status: "v9_shadow",
    tankId: String(args.tank.id),
    tankNumber,
    updatedAt: serverTimestamp(),
    entries: boundedEntries,
  });


  return snapshot;
}
