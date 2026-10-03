export type TankScheduleStatus = "planned" | "active" | "completed" | "cancelled";

export type TankSchedulePackaging = {
  planId: string;
  productId: string;
  quantity: number;
  date?: string;
  emptiesTank?: boolean;
};

export type TankScheduleCycle = {
  cycleId: string;
  /** Forecast only while planned; may renumber when earlier planned brews change. */
  plannedBatchNumber?: string;
  /** Immutable only after the brew actually enters execution. */
  batchNumber?: string;
  style: string;
  brewDate: string;
  readyDate?: string;
  emptyDate?: string;
  status: TankScheduleStatus;
  packaging: TankSchedulePackaging[];
};

export type TankScheduleConflict = { cycleId: string; message: string };

export function orderedTankSchedule(cycles: TankScheduleCycle[]): TankScheduleCycle[] {
  return [...cycles].sort((a, b) =>
    a.brewDate.localeCompare(b.brewDate) || a.cycleId.localeCompare(b.cycleId),
  );
}

export function tankCycleAt(cycles: TankScheduleCycle[], date: string): TankScheduleCycle | null {
  return orderedTankSchedule(cycles).find((cycle) =>
    cycle.status !== "cancelled" &&
    cycle.brewDate <= date &&
    (!cycle.emptyDate || date <= cycle.emptyDate),
  ) ?? null;
}

export function validateTankSchedule(cycles: TankScheduleCycle[]): TankScheduleConflict[] {
  const active = orderedTankSchedule(cycles).filter((cycle) => cycle.status !== "cancelled");
  const conflicts: TankScheduleConflict[] = [];
  for (let index = 0; index < active.length; index += 1) {
    const cycle = active[index];
    const next = active[index + 1];
    if (cycle.readyDate && cycle.readyDate < cycle.brewDate)
      conflicts.push({ cycleId: cycle.cycleId, message: "מועד הבשלה קודם למועד הבישול" });
    if (cycle.emptyDate && cycle.emptyDate < cycle.brewDate)
      conflicts.push({ cycleId: cycle.cycleId, message: "מועד ריקון קודם למועד הבישול" });
    if (next && (!cycle.emptyDate || next.brewDate <= cycle.emptyDate))
      conflicts.push({ cycleId: next.cycleId, message: "הבישול הבא מתחיל לפני שהמחזור הקודם התרוקן" });
    for (const packaging of cycle.packaging) {
      if (packaging.date && packaging.date < cycle.brewDate)
        conflicts.push({ cycleId: cycle.cycleId, message: "אריזה משויכת למחזור לפני מועד הבישול שלו" });
      if (packaging.date && cycle.emptyDate && packaging.date > cycle.emptyDate)
        conflicts.push({ cycleId: cycle.cycleId, message: "אריזה משויכת למחזור אחרי מועד הריקון שלו" });
    }
  }
  return conflicts;
}

export function upsertTankScheduleCycle(cycles: TankScheduleCycle[], incoming: TankScheduleCycle[]): TankScheduleCycle[];
export function upsertTankScheduleCycle(cycles: TankScheduleCycle[], incoming: TankScheduleCycle): TankScheduleCycle[];
export function upsertTankScheduleCycle(cycles: TankScheduleCycle[], incoming: TankScheduleCycle | TankScheduleCycle[]): TankScheduleCycle[] {
  const additions = Array.isArray(incoming) ? incoming : [incoming];
  const ids = new Set(additions.map((cycle) => cycle.cycleId));
  const next = cycles.filter((cycle) => !ids.has(cycle.cycleId));
  next.push(...additions.map((cycle) => ({ ...cycle, packaging: cycle.packaging.map((item) => ({ ...item })) })));
  const ordered = orderedTankSchedule(next);
  const conflicts = validateTankSchedule(ordered);
  if (conflicts.length) throw new Error(conflicts[0].message);
  return ordered;
}


export function tankAvailableForBrewAt(cycles: TankScheduleCycle[], date: string): boolean {
  return tankCycleAt(cycles, date) === null;
}

export function nextPlannedEmptying(cycles: TankScheduleCycle[], fromDate: string): string | null {
  return orderedTankSchedule(cycles)
    .filter((cycle) => cycle.status !== "cancelled" && cycle.emptyDate && cycle.emptyDate >= fromDate)
    .map((cycle) => cycle.emptyDate!)
    .sort()[0] ?? null;
}

export function packagingCyclesAt(
  schedules: Map<string, TankScheduleCycle[]>,
  style: string,
  date: string,
): Array<{ tankId: string; cycle: TankScheduleCycle }> {
  const normalizedStyle = style.trim().toLowerCase();
  const matches: Array<{ tankId: string; cycle: TankScheduleCycle }> = [];
  for (const [tankId, cycles] of schedules) {
    const cycle = tankCycleAt(cycles, date);
    if (!cycle || cycle.style.trim().toLowerCase() !== normalizedStyle) continue;
    if (cycle.readyDate && cycle.readyDate > date) continue;
    matches.push({ tankId, cycle });
  }
  return matches.sort((a, b) => a.tankId.localeCompare(b.tankId));
}


export function tankCanHostCycle(
  cycles: TankScheduleCycle[],
  brewDate: string,
  readyDate: string,
  ignoreCycleId?: string,
): boolean {
  const active = orderedTankSchedule(cycles).filter(
    (cycle) => cycle.status !== "cancelled" && cycle.cycleId !== ignoreCycleId,
  );
  if (active.some((cycle) =>
    cycle.brewDate <= brewDate && (!cycle.emptyDate || brewDate <= cycle.emptyDate),
  )) return false;
  const next = active.find((cycle) => cycle.brewDate > brewDate);
  return !next || readyDate < next.brewDate;
}
