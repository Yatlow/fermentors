export type PlatoForecastTank = { id: string; tankNumber?: unknown; beerStyle?: unknown; stage?: { name?: string } | null };
export type PlatoForecastReading = { id?: string | number | null; plato?: string | number | null; notes?: string | number | null };
export type PlatoForecastSpecs = { tolorances?: Record<string, number> };

/** A date to re-measure, not a prediction that an action is already justified. */
export type PlatoThresholdHint = {
  id: string;
  tankNumber: string;
  dueDate: string;
  title: string;
  basis: string;
};

/** Project a limited 7-day recheck window from two different recent dates.
 * Future pressure and temperature are deliberately NOT extrapolated.
 */
export function projectPlatoThresholdRecheck(
  tank: PlatoForecastTank, readings: PlatoForecastReading[], today: string, specs: PlatoForecastSpecs,
): PlatoThresholdHint[] {
  if (tank.stage?.name !== "בתסיסה") return [];
  const style = String(tank.beerStyle ?? "").toLowerCase();
  const hoppy = /ipa|איפא|פייל|הופי/.test(style);
  const notes = readings.map((item) => String(item.notes ?? "")).join(" ");
  if (hoppy ? notes.includes("כשות") : /סגיר(?:ת|ה).*(?:נשם|לחץ)/.test(notes)) return [];
  const dates = new Map<string, number>();
  for (const item of [...readings].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")))) {
    const date = String(item.id ?? "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date || date > today || item.plato === "" || item.plato == null) continue;
    const plato = Number(item.plato);
    if (Number.isFinite(plato) && plato >= 0 && plato <= 30) dates.set(date, plato);
  }
  const recent = [...dates].sort(([a], [b]) => a.localeCompare(b)).slice(-2);
  if (recent.length !== 2) return [];
  const [[fromDate, from], [toDate, to]] = recent;
  const day = (value: string) => Date.parse(value + "T12:00:00Z") / 86400000;
  const interval = day(toDate) - day(fromDate);
  if (interval < 1 || interval > 3 || day(today) - day(toDate) > 2) return [];
  const rate = (from - to) / interval;
  if (rate < 0.1 || rate > 4) return [];
  const setting = hoppy ? specs.tolorances?.dryHopMinPlato : specs.tolorances?.shutTankMinPlato;
  const threshold = Number(setting) > 0 ? Number(setting) : hoppy ? 8 : 5;
  if (to < threshold) return [];
  const days = Math.floor((to - threshold) / rate) + 1;
  const projected = day(toDate) + days;
  if (projected < day(today) || projected > day(today) + 6) return [];
  const dueDate = new Date(projected * 86400000).toISOString().slice(0, 10);
  const tankNumber = String(tank.tankNumber ?? tank.id);
  return [{
    id: `${tank.id}:plato-recheck:${dueDate}`,
    tankNumber, dueDate,
    title: hoppy ? "בדיקת תנאים לדרייהופ" : "בדיקת תנאים לסגירת נשם",
    basis: `הערכת מועד לפי ירידת פלאטו ${rate.toFixed(2)}°P ליום; מותנה במדידת פלאטו, טמפרטורה ולחץ באותו יום`,
  }];
}
