// Pure helpers shared by scheduled jobs and regression tests.
const dayKey = (d) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
const add = (s, n) =>
  new Date(Date.parse(`${s}T12:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10);
function targets(scheduledTime, opening = false) {
  const date = dayKey(new Date(scheduledTime)),
    weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (opening) {
    if (weekday !== 0)
      throw new Error("Opening checkpoint must be scheduled on Sunday");
    return [{ targetWeek: date, checkpoint: "opening" }];
  }
  if (weekday !== 5)
    throw new Error("Advance checkpoint must be scheduled on Friday");
  return [1, 2, 3, 4].map((n) => ({
    targetWeek: add(date, 2 + (n - 1) * 7),
    checkpoint: `lead${n}`,
  }));
}
const millis = (value) =>
  value?.toMillis?.() ??
  (typeof value?.seconds === "number" ? value.seconds * 1000 : NaN);
function selectVersion(revisions, live, cutoff) {
  const eligible = revisions
    .filter((x) => millis(x.updatedAt) <= cutoff)
    .sort(
      (a, b) =>
        millis(b.updatedAt) - millis(a.updatedAt) ||
        (b.revision ?? 0) - (a.revision ?? 0),
    );
  if (eligible.length) return { state: "captured", value: eligible[0] };
  if (!live) return { state: "no-plan", value: null };
  if (millis(live.updatedAt) <= cutoff)
    return { state: "captured", value: live };
  if (millis(live.createdAt) > cutoff) return { state: "no-plan", value: null };
  return { state: "history-unavailable", value: null };
}
module.exports = { targets, selectVersion };
