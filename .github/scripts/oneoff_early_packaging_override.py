from pathlib import Path

pc = Path("src/SERVICES/planning/productionCycle.ts")
text = pc.read_text()
old = '''export function validateProduction(
  plans: WeekPlan[],
  settings: Settings,
  tanks: Tank[],
  actuals: Actual[],
  today: string,
): string | null {'''
new = '''export function validateProduction(
  plans: WeekPlan[],
  settings: Settings,
  tanks: Tank[],
  actuals: Actual[],
  today: string,
  options?: { allowEarlyPackaging?: boolean },
): string | null {'''
if old not in text:
    raise SystemExit("validateProduction signature not found")
text = text.replace(old, new, 1)

old = '''    if (!t || !p || !sameStyle(t.style, p.style) || r.date < t.ready)
      return "מיכל האריזה אינו תואם לסגנון או טרם הבשיל";'''
new = '''    if (!t || !p || !sameStyle(t.style, p.style))
      return "מיכל האריזה אינו תואם לסגנון";
    if (r.date < t.ready && !options?.allowEarlyPackaging)
      return `מיכל ${t.number}: האריזה שובצה ל-${r.date} לפני מועד ההבשלה ${t.ready}`;'''
if old not in text:
    raise SystemExit("combined packaging readiness validation not found")
pc.write_text(text.replace(old, new, 1))

board = Path("src/components/planning/PlanningBoard.tsx")
text = board.read_text()
old = 'import { useMemo, useState } from "react";'
new = 'import { useMemo, useRef, useState } from "react";'
if old not in text:
    raise SystemExit("React import not found")
text = text.replace(old, new, 1)

old = '''  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);'''
new = '''  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [earlyPackagingWarning, setEarlyPackagingWarning] = useState<string | null>(null);
  const earlyPackagingResolver = useRef<((approved: boolean) => void) | null>(null);'''
if old not in text:
    raise SystemExit("state insertion point not found")
text = text.replace(old, new, 1)

old = '''  async function persist(next: WeekPlan, confirmBrews = false) {'''
new = '''  function requestEarlyPackagingOverride(warning: string) {
    return new Promise<boolean>((resolve) => {
      earlyPackagingResolver.current = resolve;
      setEarlyPackagingWarning(warning);
    });
  }

  function resolveEarlyPackagingOverride(approved: boolean) {
    const resolve = earlyPackagingResolver.current;
    earlyPackagingResolver.current = null;
    setEarlyPackagingWarning(null);
    resolve?.(approved);
  }

  async function persist(next: WeekPlan, confirmBrews = false) {'''
if old not in text:
    raise SystemExit("persist insertion point not found")
text = text.replace(old, new, 1)

old = '''    const production = validateProduction(datedOnly, settings, futureTanks(tanks, all, settings), actuals, today);
    if (production) throw new Error(production);'''
new = '''    const validationTanks = futureTanks(tanks, all, settings);
    let production = validateProduction(datedOnly, settings, validationTanks, actuals, today);
    if (production?.includes("לפני מועד ההבשלה")) {
      // Read-only users cannot reach persist at all. For users with planning
      // write access, early packaging is an explicit operational exception.
      setBusy(false);
      const approved = await requestEarlyPackagingOverride(production);
      if (!approved) throw new Error("השיבוץ בוטל.");
      setBusy(true);
      production = validateProduction(
        datedOnly,
        settings,
        validationTanks,
        actuals,
        today,
        { allowEarlyPackaging: true },
      );
    }
    if (production) throw new Error(production);'''
if old not in text:
    raise SystemExit("production validation block not found")
text = text.replace(old, new, 1)

old = '''  return <section>
    {busy && !brewDraft && <BeerLoader overlay message="שומר את התכנון…" />}'''
new = '''  return <section>
    {earlyPackagingWarning && <div className="bp-modal-backdrop" role="presentation">
      <div className="bp-modal" role="dialog" aria-modal="true" aria-labelledby="bp-early-packaging-title">
        <div className="bp-editor-header">
          <div>
            <h3 id="bp-early-packaging-title">חריגה ממועד הבשלת המיכל</h3>
            <small>האריזה שובצה לפני המועד שבו המיכל צפוי להיות בשל.</small>
          </div>
        </div>
        <p className="bp-alert">{earlyPackagingWarning}</p>
        <p>אפשר לחרוג מההתראה ולשמור את השיבוץ בכל זאת. זו חריגה תפעולית בהחלטת המתכנן או מנהל העבודה.</p>
        <div className="bp-actions">
          <button type="button" onClick={() => resolveEarlyPackagingOverride(false)}>ביטול</button>
          <button type="button" className="bp-action-warning" onClick={() => resolveEarlyPackagingOverride(true)}>חרוג ושבץ</button>
        </div>
      </div>
    </div>}
    {busy && !brewDraft && <BeerLoader overlay message="שומר את התכנון…" />}'''
if old not in text:
    raise SystemExit("main return insertion point not found")
board.write_text(text.replace(old, new, 1))
