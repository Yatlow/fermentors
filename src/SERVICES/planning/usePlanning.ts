import { useEffect, useState } from "react";
import { weekIsClosed, withSpecialTotals } from "./planningPresentation";
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import type { ShipmentEvent } from "./dailyPlanner";
import type { PlanningSnapshot } from "./planningReports";
import { auth, db } from "../../firebase";
import type { Pallet } from "../cooler/Pallettypes ";
import {
  addDays,
  defaultSettings,
  emptyWeek,
  weekStart,
  parseDate,
  type TankInput,
  type Actual,
  type Holiday,
  type Settings,
  type WeekPlan,
} from "./planningEngine";

const PLANNING_TIME_ZONE = "Asia/Jerusalem";
const JERUSALEM_PARTS = new Intl.DateTimeFormat("en-US-u-nu-latn", {
  timeZone: PLANNING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export type PlanningReadScope = {
  plans?: boolean;
  shipments?: boolean;
  pallets?: boolean;
  actuals?: boolean;
  snapshots?: boolean;
};

function zonedParts(date: Date): Record<string, string> {
  return Object.fromEntries(
    JERUSALEM_PARTS.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function jerusalemOffsetMs(date: Date): number {
  const parts = zonedParts(date);
  const representedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return representedAsUtc - date.getTime();
}

/** Returns the UTC instant corresponding to 00:00 in Asia/Jerusalem. */
export function startOfJerusalemDay(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid planning date: ${value}`);

  const wallClockUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );

  let instantMs = wallClockUtc;
  for (let i = 0; i < 3; i += 1) {
    const next = wallClockUtc - jerusalemOffsetMs(new Date(instantMs));
    if (next === instantMs) break;
    instantMs = next;
  }
  return new Date(instantMs);
}

export function jerusalemDateKey(date: Date): string {
  const parts = zonedParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isTempoCustomer(customerId: unknown, customerName: unknown) {
  if (typeof customerId === "string" && customerId.trim()) {
    return customerId.trim().toLowerCase() === "tempo";
  }
  const customer = String(customerName ?? "").trim();
  return /טמפו|tempo/i.test(customer);
}

export function usePlanning(
  today: string,
  tanks: TankInput[],
  scope: PlanningReadScope = {
    plans: true,
    shipments: true,
    pallets: true,
    actuals: true,
    snapshots: false,
  },
) {
  const [actualShipments, setActualShipments] = useState<ShipmentEvent[]>([]);
  const [snapshots, setSnapshots] = useState<PlanningSnapshot[]>([]);
  const [snapshotError, setSnapshotError] = useState("");
  const [settings, setSettings] = useState<Settings>(() =>
    withSpecialTotals(defaultSettings()),
  );
  const [plans, setPlans] = useState<WeekPlan[]>([]);
  const [pallets, setPallets] = useState<Pallet[]>([]);
  const [actuals, setActuals] = useState<Actual[]>([]);
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [offline, setOffline] = useState<Record<string, boolean>>({});

  const start = weekStart(today);
  const end = addDays(start, 84);
  const logStart = [
    addDays(start, -84),
    ...tanks
      .filter((t) => t.tankStatus !== true && t.batchNumber)
      .map((t) => parseDate(t.brewDate))
      .filter((d): d is string => !!d && d < today),
  ].sort()[0];

  const wantsPlans = scope.plans !== false;
  const wantsShipments = scope.shipments !== false;
  const wantsPallets = scope.pallets !== false;
  const wantsActuals = scope.actuals !== false;
  const wantsSnapshots = scope.snapshots === true;

  const setPending = (key: string) => {
    setReady((current) => ({ ...current, [key]: false }));
    setErrors((current) => ({ ...current, [key]: "" }));
  };
  const ok = (key: string, cache: boolean) => {
    setReady((current) => ({ ...current, [key]: true }));
    setOffline((current) => ({ ...current, [key]: cache }));
    setErrors((current) => ({ ...current, [key]: "" }));
  };
  const fail = (key: string) => (error: Error) => {
    setReady((current) => ({ ...current, [key]: true }));
    setErrors((current) => ({ ...current, [key]: `${key}: ${error.message}` }));
  };

  // Settings are tiny and are required by every planning tab.
  useEffect(() => {
    setPending("הגדרות");
    return onSnapshot(
      doc(db, "planningSettings", "main"),
      { includeMetadataChanges: true },
      (snap) => {
        setSettings(
          withSpecialTotals(
            snap.exists()
              ? ({
                  ...defaultSettings(),
                  ...snap.data(),
                  lossPercent: 10,
                  deliveryTransitDays: 0,
                  totalTargetWeeks: snap.data()?.totalTargetWeeks ?? 8.5,
                } as Settings)
              : defaultSettings(),
          ),
        );
        ok("הגדרות", snap.metadata.fromCache);
      },
      fail("הגדרות"),
    );
  }, []);

  // Keep each dataset in its own effect. Previously logStart was a dependency of
  // one giant effect, so a tank-date/status change tore down and re-subscribed
  // settings, plans, shipments, pallets and packaging history together.
  useEffect(() => {
    if (!wantsPlans) {
      setPlans([]);
      return;
    }
    setPending("תוכניות");
    return onSnapshot(
      query(
        collection(db, "planningWeeks"),
        where("id", ">=", addDays(start, -84)),
        where("id", "<", end),
      ),
      { includeMetadataChanges: true },
      (snap) => {
        setPlans(snap.docs.map((item) => item.data() as WeekPlan));
        ok("תוכניות", snap.metadata.fromCache);
      },
      fail("תוכניות"),
    );
  }, [start, end, wantsPlans]);

  useEffect(() => {
    if (!wantsShipments) {
      setActualShipments([]);
      return;
    }
    setPending("משלוחים");
    const startInstant = Timestamp.fromDate(startOfJerusalemDay(start));
    const endInstant = Timestamp.fromDate(startOfJerusalemDay(end));
    return onSnapshot(
      query(
        collection(db, "shipments"),
        where("createdAt", ">=", startInstant),
        where("createdAt", "<", endInstant),
      ),
      { includeMetadataChanges: true },
      (snap) => {
        setActualShipments(
          snap.docs.flatMap((item) => {
            const data = item.data();
            if (!isTempoCustomer(data.customerId, data.customerName)) return [];
            const date = data.createdAt?.toDate?.();
            return date ? [{
              id: item.id,
              date: jerusalemDateKey(date),
              shipmentNumber: Number(data.shipmentNumber) || undefined,
              totals: Array.isArray(data.totals) ? data.totals : [],
            }] : [];
          }),
        );
        ok("משלוחים", snap.metadata.fromCache);
      },
      fail("משלוחים"),
    );
  }, [start, end, wantsShipments]);

  useEffect(() => {
    if (!wantsPallets) {
      setPallets([]);
      return;
    }
    setPending("מלאי");
    return onSnapshot(
      query(
        collection(db, "pallets"),
        where("zone", "in", ["cooler", "pending", "bottleRoom", "loadingDock"]),
      ),
      { includeMetadataChanges: true },
      (snap) => {
        setPallets(snap.docs.map((item) => ({ ...item.data(), id: item.id }) as Pallet));
        ok("מלאי", snap.metadata.fromCache);
      },
      fail("מלאי"),
    );
  }, [wantsPallets]);

  useEffect(() => {
    if (!wantsActuals) {
      setActuals([]);
      return;
    }
    setPending("אריזות");
    return onSnapshot(
      query(
        collection(db, "packagingLog"),
        where("timestamp", ">=", startOfJerusalemDay(logStart).getTime()),
        where("timestamp", "<", startOfJerusalemDay(end).getTime()),
      ),
      { includeMetadataChanges: true },
      (snap) => {
        setActuals(snap.docs.map((item) => ({ ...item.data(), id: item.id }) as Actual));
        ok("אריזות", snap.metadata.fromCache);
      },
      fail("אריזות"),
    );
  }, [logStart, end, wantsActuals]);

  useEffect(() => {
    if (!wantsSnapshots) {
      setSnapshots([]);
      setSnapshotError("");
      return;
    }
    setPending("סנאפשוטים");
    return onSnapshot(
      query(
        collection(db, "planningSnapshots"),
        where("targetWeek", ">=", addDays(start, -84)),
        where("targetWeek", "<", end),
      ),
      (snap) => {
        setSnapshots(
          snap.docs.map((item) => ({ ...item.data(), id: item.id }) as PlanningSnapshot),
        );
        setSnapshotError("");
        ok("סנאפשוטים", snap.metadata.fromCache);
      },
      (error) => {
        setSnapshotError(error.message);
        fail("סנאפשוטים")(error);
      },
    );
  }, [start, end, wantsSnapshots]);

  async function save(
    collectionName: string,
    id: string,
    value: Settings | WeekPlan,
    options?: { allowClosedWeek?: boolean },
  ) {
    if (!auth.currentUser) throw new Error("יש להתחבר מחדש");
    await runTransaction(db, async (tx) => {
      if (
        collectionName === "planningWeeks" &&
        weekIsClosed(id) &&
        options?.allowClosedWeek !== true
      )
        throw new Error(
          "השבוע נסגר לתכנון בתחילת יום שישי. ניתן לצפות בו בלבד.",
        );
      const ref = doc(db, collectionName, id),
        snap = await tx.get(ref);
      if ((snap.data()?.revision ?? 0) !== value.revision)
        throw new Error(
          "התכנון עודכן במכשיר אחר. סגור את העריכה ופתח מחדש כדי לקבל את העדכון.",
        );
      const next = {
        ...value,
        createdAt: snap.exists()
          ? (snap.data()?.createdAt ?? null)
          : serverTimestamp(),
        revision: value.revision + 1,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser!.uid,
      };
      const revisionRef = doc(ref, "revisions", String(next.revision));
      tx.set(ref, next);
      tx.set(revisionRef, next);
    });
  }

  async function moveCalendarEvent(
    sourceWeekId: string,
    targetWeekId: string,
    eventId: string,
    nextEvent: {
      id: string;
      title: string;
      startDate: string;
      endDate: string;
      type: "general";
      note?: string;
    },
  ) {
    if (!auth.currentUser) throw new Error("יש להתחבר מחדש");

    await runTransaction(db, async (tx) => {
      const sourceRef = doc(db, "planningWeeks", sourceWeekId);
      const sourceSnap = await tx.get(sourceRef);
      if (!sourceSnap.exists()) throw new Error("שבוע המקור לא נמצא");

      const sourceData = sourceSnap.data() as WeekPlan & {
        calendarEvents?: typeof nextEvent[];
      };
      const sourceEvents = Array.isArray(sourceData.calendarEvents)
        ? sourceData.calendarEvents
        : [];
      if (!sourceEvents.some((event) => event.id === eventId)) {
        throw new Error("האירוע כבר לא קיים בתכנון");
      }

      const makeNext = (
        base: WeekPlan & { calendarEvents?: typeof nextEvent[]; createdAt?: unknown },
        events: typeof nextEvent[],
        reason: string,
        createdAt: unknown,
      ) => ({
        ...base,
        calendarEvents: events,
        changeReason: reason,
        createdAt,
        revision: Number(base.revision ?? 0) + 1,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser!.uid,
      });

      if (sourceWeekId === targetWeekId) {
        const next = makeNext(
          sourceData,
          sourceEvents.map((event) => event.id === eventId ? nextEvent : event),
          "שינוי תאריכי אירוע ידני",
          sourceData.createdAt ?? null,
        );
        tx.set(sourceRef, next);
        tx.set(doc(sourceRef, "revisions", String(next.revision)), next);
        return;
      }

      const targetRef = doc(db, "planningWeeks", targetWeekId);
      const targetSnap = await tx.get(targetRef);
      const targetData = (
        targetSnap.exists()
          ? targetSnap.data()
          : { ...emptyWeek(targetWeekId), maxRuns: settings.preferredRuns }
      ) as WeekPlan & {
        calendarEvents?: typeof nextEvent[];
        createdAt?: unknown;
      };
      const targetEvents = Array.isArray(targetData.calendarEvents)
        ? targetData.calendarEvents.filter((event) => event.id !== eventId)
        : [];

      const sourceNext = makeNext(
        sourceData,
        sourceEvents.filter((event) => event.id !== eventId),
        "העברת אירוע ידני לשבוע אחר",
        sourceData.createdAt ?? null,
      );
      const targetNext = makeNext(
        targetData,
        [...targetEvents, nextEvent],
        "העברת אירוע ידני משבוע אחר",
        targetSnap.exists() ? (targetData.createdAt ?? null) : serverTimestamp(),
      );

      tx.set(sourceRef, sourceNext);
      tx.set(doc(sourceRef, "revisions", String(sourceNext.revision)), sourceNext);
      tx.set(targetRef, targetNext);
      tx.set(doc(targetRef, "revisions", String(targetNext.revision)), targetNext);
    });
  }

  const requiredKeys = [
    "הגדרות",
    ...(wantsPlans ? ["תוכניות"] : []),
    ...(wantsShipments ? ["משלוחים"] : []),
    ...(wantsPallets ? ["מלאי"] : []),
    ...(wantsActuals ? ["אריזות"] : []),
    ...(wantsSnapshots ? ["סנאפשוטים"] : []),
  ];

  return {
    settings,
    plans,
    pallets,
    actuals,
    actualShipments,
    snapshots,
    snapshotError,
    loading: requiredKeys.some((key) => ready[key] !== true),
    error: requiredKeys.map((key) => errors[key]).filter(Boolean).join(" · "),
    offline: requiredKeys.some((key) => offline[key] === true),
    saveSettings: (s: Settings) => save("planningSettings", "main", s),
    saveWeek: (w: WeekPlan, options?: { allowClosedWeek?: boolean }) =>
      save("planningWeeks", w.id, w, options),
    moveCalendarEvent,
  };
}

export function usePlanningToday() {
  const [today, setToday] = useState(() => jerusalemDateKey(new Date()));
  useEffect(() => {
    const id = setInterval(() => setToday(jerusalemDateKey(new Date())), 60000);
    return () => clearInterval(id);
  }, []);
  return today;
}

export function useHolidays(start: string, end: string) {
  const [holidays, setHolidays] = useState<Holiday[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(), 12000);
    const other: Holiday[] = [];
    for (
      let year = Number(start.slice(0, 4));
      year <= Number(end.slice(0, 4));
      year++
    ) {
      const nov = new Date(Date.UTC(year, 10, 1, 12));
      const thanksgiving = 1 + ((4 - nov.getUTCDay() + 7) % 7) + 21;
      other.push(
        { date: `${year}-12-25`, title: "כריסטמס" },
        { date: `${year}-11-${thanksgiving}`, title: "חג ההודיה (ארה״ב)" },
        { date: `${year}-01-01`, title: "ראש השנה האזרחית" },
      );
    }
    setHolidays(other);
    setError("");
    fetch(
      `https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=on&mod=on&i=on&lg=he&start=${start}&end=${end}`,
      { signal: controller.signal },
    )
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((data) => {
        if (!controller.signal.aborted)
          setHolidays([
            ...other,
            ...(data.items ?? [])
              .filter((item: { category: string }) => item.category === "holiday")
              .map(
                (item: {
                  date: string;
                  hebrew?: string;
                  title: string;
                  yomtov?: boolean;
                }) => ({
                  date: item.date.slice(0, 10),
                  title: item.hebrew ?? item.title,
                  closed: !!item.yomtov,
                }),
              ),
          ]);
      })
      .catch(() => {
        if (!disposed)
          setError("לא ניתן לטעון חגים יהודיים. יש לבדוק את ימי העבודה ידנית.");
      })
      .finally(() => clearTimeout(timer));
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [start, end]);
  return { holidays, error };
}
