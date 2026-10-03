from pathlib import Path

p = Path('src/components/planning/PlanningWeeklyRecommendations.tsx')
s = p.read_text(encoding='utf-8')

old = 'type BrewDraft = { style: string; liters: number };'
new = 'type BrewDraft = { style: string; liters: number; allowUnavailable?: boolean };'
if old not in s and new not in s:
    raise SystemExit('BrewDraft type anchor not found')
s = s.replace(old, new, 1)

old = '''            const style = recommendation?.style ?? CORE_STYLES[0];
            return [...rows, { style, liters: brewLitersForSize(style, size) }];
        });
        // An unavailable-tank override is intentionally one-shot: every extra
        // brew beyond the available tank pool requires a fresh explicit approval.
        if (allowUnavailableBrewException) setAllowUnavailableBrewException(false);'''
new = '''            const style = recommendation?.style ?? CORE_STYLES[0];
            return [...rows, {
                style,
                liters: brewLitersForSize(style, size),
                ...(allowUnavailableBrewException ? { allowUnavailable: true } : {}),
            }];
        });
        // The approval is one-shot for adding another brew, but it belongs to
        // the row that was just added. That row may still be changed between
        // single/double/triple even when the selected size currently has no
        // available tank. Adding another exceptional brew requires approval again.
        if (allowUnavailableBrewException) setAllowUnavailableBrewException(false);'''
if old not in s and '...(allowUnavailableBrewException ? { allowUnavailable: true } : {})' not in s:
    raise SystemExit('addBrew anchor not found')
s = s.replace(old, new, 1)

old = '''    function changeBrewSize(index: number, size: BrewSizeLabel) {
        setBrewDraft((rows) => {
            if (!canUseBrewSize(rows, size, index)) return rows;
            return rows.map((row, i) => i === index
                ? { ...row, liters: brewLitersForSize(row.style, size) }
                : row));
        });
    }'''
new = '''    function changeBrewSize(index: number, size: BrewSizeLabel) {
        setBrewDraft((rows) => {
            if (!rows[index]?.allowUnavailable && !canUseBrewSize(rows, size, index)) return rows;
            return rows.map((row, i) => i === index
                ? { ...row, liters: brewLitersForSize(row.style, size) }
                : row));
        });
    }'''
if old not in s and 'if (!rows[index]?.allowUnavailable && !canUseBrewSize' not in s:
    raise SystemExit('changeBrewSize anchor not found')
s = s.replace(old, new, 1)

old = 'disabled={size !== currentSize && !canUseBrewSize(brewDraft, size, i)}'
new = 'disabled={!b.allowUnavailable && size !== currentSize && !canUseBrewSize(brewDraft, size, i)}'
if old not in s and new not in s:
    raise SystemExit('select disabled anchor not found')
s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')
print('Applied per-row unavailable-tank brew override fix.')
