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

export function usePlanning(today: string, tanks: TankInput[], loadSnapshots = false) {
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
  const start = weekStart(today),
    end = addDays(start, 84);
  const logStart = [
    addDays(start, -84),
    ...tanks
      .filter((t) => t.tankStatus !== true && t.batchNumber)
      .map((t) => parseDate(t.brewDate))
      .filter((d): d is string => !!d && d < today),
  ].sort()[0];

  useEffect(() => {
    setReady({});
    setErrors({});
    const ok = (key: string, cache: boolean) => {
      setReady((x) => ({ ...x, [key]: true }));
      setOffline((x) => ({ ...x, [key]: cache }));
      setErrors((x) => ({ ...x, [key]: "" }));
    };
    const fail = (key: string) => (e: Error) =>
      setErrors((x) => ({ ...x, [key]: `${key}: ${e.message}` }));

    let unsubscribeSnapshots: () => void = () => {};
    if (loadSnapshots) {
      unsubscribeSnapshots = onSnapshot(
        query(
          collection(db, "planningSnapshots"),
          where("targetWeek", ">=", addDays(start, -84)),
          where("targetWeek", "<", end),
        ),
        (snap) => {
          setSnapshots(
            snap.docs.map(
              (d) => ({ ...d.data(), id: d.id }) as PlanningSnapshot,
            ),
          );
          setSnapshotError("");
        },
        (e) => setSnapshotError(e.message),
      );
    } else {
      setSnapshots([]);
      setSnapshotError("");
    }

    const unsub = [
      onSnapshot(
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
      ),
      onSnapshot(
        query(
          collection(db, "planningWeeks"),
          where("id", ">=", addDays(start, -84)),
          where("id", "<", end),
        ),
        { includeMetadataChanges: true },
        (snap) => {
          setPlans(snap.docs.map((d) => d.data() as WeekPlan));
          ok("תוכניות", snap.metadata.fromCache);
        },
        fail("תוכניות"),
      ),
      onSnapshot(
        query(
          collection(db, "shipments"),
          where(
            "createdAt",
            ">=",
            Timestamp.fromDate(startOfJerusalemDay(start)),
          ),
        ),
        { includeMetadataChanges: true },
        (snap) => {
          setActualShipments(
            snap.docs.flatMap((d) => {
              const data = d.data();
              if (!isTempoCustomer(data.customerId, data.customerName)) return [];
              const date = data.createdAt?.toDate?.();
              return date ? [{
                id: d.id,
                date: jerusalemDateKey(date),
                shipmentNumber: Number(data.shipmentNumber) || undefined,
                totals: Array.isArray(data.totals) ? data.totals : [],
              }] : [];
            }),
          );
          ok("משלוחים", snap.metadata.fromCache);
        },
        fail("משלוחים"),
      ),
      onSnapshot(
        query(
          collection(db, "pallets"),
          where("zone", "in", [
            "cooler",
            "pending",
            "bottleRoom",
            "loadingDock",
          ]),
        ),
        { includeMetadataChanges: true },
        (snap) => {
          setPallets(
            snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Pallet),
          );
          ok("מלאי", snap.metadata.fromCache);
        },
        fail("מלאי"),
      ),
      onSnapshot(
        query(
          collection(db, "packagingLog"),
          where("timestamp", ">=", startOfJerusalemDay(logStart).getTime()),
          where("timestamp", "<", startOfJerusalemDay(end).getTime()),
        ),
        { includeMetadataChanges: true },
        (snap) => {
          setActuals(
            snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Actual),
          );
          ok("אריזות", snap.metadata.fromCache);
        },
        fail("אריזות"),
      ),
    ];
    return () => {
      unsubscribeSnapshots();
      unsub.forEach((fn) => fn());
    };
  }, [start, end, logStart, loadSnapshots]);

  async function save(
    collectionName: string,
    id: string,
    value: Settings | WeekPlan,
  ) {
    if (!auth.currentUser) throw new Error("יש להתחבר מחדש");
    await runTransaction(db, async (tx) => {
      if (collectionName === "planningWeeks" && weekIsClosed(id))
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

  return {
    settings,
    plans,
    pallets,
    actuals,
    actualShipments,
    snapshots,
    snapshotError,
    loading: Object.keys(ready).length < 5,
    error: Object.values(errors).filter(Boolean).join(" · "),
    offline: Object.values(offline).some(Boolean),
    saveSettings: (s: Settings) => save("planningSettings", "main", s),
    saveWeek: (w: WeekPlan) => save("planningWeeks", w.id, w),
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
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((data) => {
        if (!controller.signal.aborted)
          setHolidays([
            ...other,
            ...(data.items ?? [])
              .filter((x: { category: string }) => x.category === "holiday")
              .map(
                (x: {
                  date: string;
                  hebrew?: string;
                  title: string;
                  yomtov?: boolean;
                }) => ({
                  date: x.date.slice(0, 10),
                  title: x.hebrew ?? x.title,
                  closed: !!x.yomtov,
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
