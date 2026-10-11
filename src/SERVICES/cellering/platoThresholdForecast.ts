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
  const hoppy = /ipa|פייל|הופי|pale|hoppy/.test(style);
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

/** Lager diacetyl-rest is triggered by measured conditions, not Plato alone.
 * A future row is deliberately a *check* because future tank temperature is
 * unknown. A "ready" row requires a recent measured 9–13°C and Plato below
 * the current engine's threshold.
 */
export function projectLagerDiacetylRest(
  tank: PlatoForecastTank,
  readings: (PlatoForecastReading & { temp?: string | number | null })[],
  today: string,
  specs: PlatoForecastSpecs,
): PlatoThresholdHint[] {
  if (tank.stage?.name !== "בתסיסה" || !String(tank.beerStyle ?? "").toLowerCase().includes("לאגר")) return [];
  if (readings.some((row) => /דיאציטיל|מנוחה/.test(String(row.notes ?? "")))) return [];
  const rows = readings.flatMap((row) => {
    const date = String(row.id ?? "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date || date > today || row.plato === null || row.plato === undefined || row.plato === "") return [];
    const plato = Number(row.plato);
    return Number.isFinite(plato) && plato >= 0 && plato <= 30 ? [{ date, plato, temp: row.temp }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return [];
  const last = rows[rows.length - 1];
  const day = (date: string) => Date.parse(date + "T12:00:00Z") / 86400000;
  if (day(today) - day(last.date) > 2) return [];
  const raw = Number(specs.tolorances?.dycitalRestMinPlato);
  const threshold = Number.isFinite(raw) && raw > 0 ? raw : 8;
  const number = String(tank.tankNumber ?? tank.id);
  if (last.plato < threshold) {
    const temp = Number(last.temp);
    if (last.temp == null || last.temp === "" || !Number.isFinite(temp) || temp <= 9 || temp >= 13) return [];
    return [{
      id: `${tank.id}:diacetyl-ready:${today}`,
      tankNumber: number,
      dueDate: today,
      title: "מנוחת דיאציטיל — תנאי המדידה מתקיימים",
      basis: `פלאטו ${last.plato}, טמפרטורה ${temp}°C במדידה מ־${last.date}; יש לאמת בזמן ביצוע`,
    }];
  }
  const unique = [...new Map(rows.map((row) => [row.date, row.plato])).entries()].slice(-2);
  if (unique.length < 2) return [];
  const [[fromDate, from], [toDate, to]] = unique;
  const interval = day(toDate) - day(fromDate);
  if (interval < 1 || interval > 3) return [];
  const rate = (from - to) / interval;
  if (rate < 0.1 || rate > 4) return [];
  const days = Math.floor((to - threshold) / rate) + 1;
  const projectedDay = day(toDate) + days;
  if (projectedDay < day(today) || projectedDay > day(today) + 6) return [];
  const date = new Date(projectedDay * 86400000).toISOString().slice(0, 10);
  return [{
    id: `${tank.id}:diacetyl-plato-recheck:${date}`,
    tankNumber: number,
    dueDate: date,
    title: "בדיקת תנאים למנוחת דיאציטיל",
    basis: "הערכת סף פלאטו בלבד; יש למדוד טמפרטורה ולאמת טווח 9–13°C באותו יום",
  }];
}

/** Cooling cannot be scheduled solely from current Plato. Project a *review*
 * once a known warm yeast-drop exists and a recent downward Plato trend nears
 * the fermentation-finish band. Do not claim that fermentation is complete.
 */
export function projectCoolingReadinessCheck(
  tank: PlatoForecastTank,
  readings: PlatoForecastReading[],
  today: string,
): PlatoThresholdHint[] {
  if (tank.stage?.name !== "בתסיסה") return [];
  const rows = [...readings].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  if (rows.some((row) => /קירור/.test(String(row.notes ?? "")))) return [];
  if (!rows.some((row) => /שמרים|שמרי/.test(String(row.notes ?? "")))) return [];
  const dates = new Map<string, number>();
  for (const row of rows) {
    const date = String(row.id ?? "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date || date > today || row.plato === "" || row.plato == null) continue;
    const plato = Number(row.plato);
    if (Number.isFinite(plato) && plato >= 0 && plato <= 30) dates.set(date, plato);
  }
  const latest = [...dates].sort(([a], [b]) => a.localeCompare(b)).slice(-2);
  if (latest.length !== 2) return [];
  const [[fromDate, from], [toDate, to]] = latest;
  const day = (date: string) => Date.parse(date + "T12:00:00Z") / 86400000;
  const gap = day(toDate) - day(fromDate);
  if (gap < 1 || gap > 3 || day(today) - day(toDate) > 2) return [];
  const rate = (from - to) / gap;
  if (rate < 0.1 || rate > 4 || to <= 0) return [];
  const threshold = 5;
  const until = to <= threshold ? 0 : Math.ceil((to - threshold) / rate);
  if (until > 6) return [];
  const projectedDay = Math.max(day(today), day(toDate) + until);
  const dueDate = new Date(projectedDay * 86400000).toISOString().slice(0, 10);
  return [{
    id: `${tank.id}:cooling-readiness:${dueDate}`,
    tankNumber: String(tank.tankNumber ?? tank.id), dueDate,
    title: "צפי לבדיקת מוכנות לקירור",
    basis: "אומדן לפי ירידת פלאטו לאחר הורדת שמרים; יש לוודא סיום תסיסה ויציבות פלאטו לפני קירור",
  }];
}
