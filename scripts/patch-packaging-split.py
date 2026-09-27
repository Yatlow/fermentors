from pathlib import Path

path = Path('src/components/planning/PlanningWeeklyRecommendations.tsx')
text = path.read_text()

marker = '''    function manualMaxQuantity(p: Product | undefined, tankId: string, manualId: string) {
        if (!p || !tankId) return 0;
        const unitsFromTank = Math.floor(remainingLitersForTank(tankId, manualId) / litersPerUnit(p));
        return p.type === "crates" ? Math.min(MAX_MANUAL_CRATES, unitsFromTank) : unitsFromTank;
    }

'''

helper = marker + '''    function changeSavedPackagingQuantity(run: Plan, key: string, requested: number) {
        setPackDraft((draft) => {
            const next = {
                ...draft,
                [key]: Math.max(completedQty(run), requested),
            };

            // A split tank has one final draining line (`emptyTank`). Treat that
            // line as the remainder. Editing an earlier line recalculates only
            // the final remainder. Editing the remainder itself stays manual.
            if (!run.tankId || run.emptyTank === true) return next;

            const remainderRun = current.packaging.find((candidate) => {
                if (candidate.tankId !== run.tankId || candidate.emptyTank !== true) return false;
                const candidateKey = candidate.id ?? `${candidate.productId}:${candidate.tankId}`;
                return candidateKey !== key && !cancelledPackagingKeys.has(candidateKey);
            });
            if (!remainderRun) return next;

            const remainderProduct = product(remainderRun.productId);
            if (!remainderProduct) return next;

            const base = model.tankAvailableLiters.get(run.tankId)
                ?? tanks.find((tank) => tank.id === run.tankId)?.liters
                ?? 0;

            let usedLiters = 0;
            for (const candidate of current.packaging) {
                if (candidate.tankId !== run.tankId || candidate === remainderRun) continue;
                const candidateKey = candidate.id ?? `${candidate.productId}:${candidate.tankId}`;
                if (cancelledPackagingKeys.has(candidateKey)) continue;
                const candidateProduct = product(candidate.productId);
                if (!candidateProduct) continue;
                const target = candidateKey === key
                    ? next[key]
                    : Math.max(0, next[candidateKey] ?? candidate.quantity);
                usedLiters += effectiveSavedRemaining(candidate, target) * litersPerUnit(candidateProduct);
            }

            for (const recommendation of visiblePackagingRecommendations) {
                if (recommendation.tankId !== run.tankId) continue;
                const quantity = Math.max(0, next[`rec:${recommendation.id}`] ?? 0);
                const recommendationProduct = product(recommendation.productId);
                if (recommendationProduct) usedLiters += quantity * litersPerUnit(recommendationProduct);
            }

            for (const manual of manualPacks) {
                if (manual.tankId !== run.tankId || !manual.productId || manual.quantity <= 0) continue;
                const manualProduct = product(manual.productId);
                if (manualProduct) usedLiters += manual.quantity * litersPerUnit(manualProduct);
            }

            const remainderLiters = Math.max(0, base - usedLiters);
            const calculated = Math.floor(remainderLiters / litersPerUnit(remainderProduct));
            const capped = remainderProduct.type === "crates"
                ? Math.min(MAX_MANUAL_CRATES, calculated)
                : calculated;
            const remainderKey = remainderRun.id ?? `${remainderRun.productId}:${remainderRun.tankId}`;
            next[remainderKey] = Math.max(completedQty(remainderRun), capped);
            return next;
        });
    }

'''

if marker not in text:
    raise SystemExit('manualMaxQuantity marker not found')
text = text.replace(marker, helper, 1)

old = '''                                <TransientNumberInput min={completed} value={value} onNumberChange={(next) => setPackDraft((d) => ({ ...d, [key]: Math.max(completed, next) }))} />'''
new = '''                                <TransientNumberInput min={completed} value={value} onNumberChange={(next) => changeSavedPackagingQuantity(r, key, next)} />'''
if old not in text:
    raise SystemExit('saved packaging input marker not found')
text = text.replace(old, new, 1)

old = '''                                <span><b>{p ? displayStyle(p.style) : r.productId}</b> · מיכל {r.tankNumber ?? tanks.find((t) => t.id === r.tankId)?.number ?? "—"}{completed > 0 && <small> · {fmt(completed)} כבר בוצעו</small>}</span>'''
new = '''                                <span><b>{p ? displayStyle(p.style) : r.productId}</b> · {p?.type === "crates" ? "ארגזים" : p?.type === "kegs" ? "חביות" : ""} · מיכל {r.tankNumber ?? tanks.find((t) => t.id === r.tankId)?.number ?? "—"}{r.emptyTank === true && <small> · יתרת המיכל</small>}{completed > 0 && <small> · {fmt(completed)} כבר בוצעו</small>}</span>'''
if old not in text:
    raise SystemExit('saved packaging label marker not found')
text = text.replace(old, new, 1)

path.write_text(text)
