from pathlib import Path

weekly = Path('src/components/planning/PlanningWeeklyRecommendations.tsx')
gantt = Path('src/components/planning/PlanningGantt.tsx')

text = weekly.read_text(encoding='utf-8')

old = '''    async function acceptBrewRecommendations() {
        if (!model.brewRecommendations.length) return;
        const additions = model.brewRecommendations.map((b) => ({
            id: crypto.randomUUID(), style: b.style, liters: b.liters, tankId: "", date: addDays(week, 1),
        }));'''
new = '''    function visibleBrewRecommendations() {
        const usedBySize = new Map<BrewSizeLabel, number>();
        for (const brew of current.brews) {
            const size = brewSizeLabel(brew.liters);
            usedBySize.set(size, (usedBySize.get(size) ?? 0) + 1);
        }
        return model.brewRecommendations.filter((recommendation) => {
            const size = recommendation.sizeLabel;
            const used = usedBySize.get(size) ?? 0;
            if (used >= brewSizeCapacity(size)) return false;
            usedBySize.set(size, used + 1);
            return true;
        });
    }

    async function acceptBrewRecommendations() {
        const recommendations = visibleBrewRecommendations();
        if (!recommendations.length) return;
        const additions = recommendations.map((b) => ({
            id: crypto.randomUUID(), style: b.style, liters: b.liters, tankId: "", date: addDays(week, 1),
        }));'''
assert old in text, 'acceptBrewRecommendations anchor not found'
text = text.replace(old, new, 1)

old = '''    function addBrew() {
        setBrewDraft((rows) => {
            const recommendation = model.brewRecommendations[rows.length];
            const recommendedSize = recommendation?.sizeLabel;
            const size = recommendedSize && canUseBrewSize(rows, recommendedSize)
                ? recommendedSize
                : BREW_SIZES.find((candidate) => canUseBrewSize(rows, candidate)) ?? recommendedSize ?? "כפול";
            const style = recommendation?.style ?? CORE_STYLES[0];
            return [...rows, { style, liters: brewLitersForSize(style, size) }];
        });
    }'''
new = '''    function addBrew() {
        setBrewDraft((rows) => {
            const recommendations = visibleBrewRecommendations();
            const recommendation = recommendations[rows.length];
            const recommendedSize = recommendation?.sizeLabel;
            const size = recommendedSize && canUseBrewSize(rows, recommendedSize)
                ? recommendedSize
                : BREW_SIZES.find((candidate) => canUseBrewSize(rows, candidate)) ?? recommendedSize ?? "כפול";
            const style = recommendation?.style ?? CORE_STYLES[0];
            return [...rows, { style, liters: brewLitersForSize(style, size) }];
        });
        // An unavailable-tank override is intentionally one-shot: every extra
        // brew beyond the available tank pool requires a fresh explicit approval.
        if (allowUnavailableBrewException) setAllowUnavailableBrewException(false);
    }'''
assert old in text, 'addBrew anchor not found'
text = text.replace(old, new, 1)

old = '''    function pushBrewRecommendationsToDraft() {
        if (!model.brewRecommendations.length) return;
        setEditing("brew");
        setBrewDraft([
            ...current.brews.map((b) => ({ style: b.style, liters: b.liters })),
            ...model.brewRecommendations.map((b) => ({ style: b.style, liters: b.liters })),
        ]);
    }'''
new = '''    function pushBrewRecommendationsToDraft() {
        const recommendations = visibleBrewRecommendations();
        if (!recommendations.length) return;
        setEditing("brew");
        setBrewDraft([
            ...current.brews.map((b) => ({ style: b.style, liters: b.liters })),
            ...recommendations.map((b) => ({ style: b.style, liters: b.liters })),
        ]);
    }'''
assert old in text, 'pushBrewRecommendationsToDraft anchor not found'
text = text.replace(old, new, 1)

text = text.replace('''<button type="button" disabled={!model.brewRecommendations.length} onClick={pushBrewRecommendationsToDraft}>צור בישולים מההמלצות</button>''', '''<button type="button" disabled={!visibleBrewRecommendations().length} onClick={pushBrewRecommendationsToDraft}>צור בישולים מההמלצות</button>''', 1)
text = text.replace('''<button type="button" disabled={disabled || busy || !model.brewRecommendations.length} onClick={acceptBrewRecommendations}>''', '''<button type="button" disabled={disabled || busy || !visibleBrewRecommendations().length} onClick={acceptBrewRecommendations}>''', 1)

old = '''                    {allowUnavailableBrewException && <small className="bp-brew-capacity-warning">חריגת זמינות פעילה לטיוטה הזו. את הבישול החריג יהיה צורך לשבץ במפורש למיכל שמתפנה לפני יום הבישול.</small>}'''
new = '''                    {allowUnavailableBrewException && <small className="bp-brew-capacity-warning">אושרה חריגה לבישול הבא בלבד. לאחר הוספתו יידרש אישור חדש לכל בישול נוסף מעבר למיכלים הזמינים.</small>}'''
assert old in text, 'override copy anchor not found'
text = text.replace(old, new, 1)

old = '''                    {model.brewRecommendations.length ? model.brewRecommendations.map((r, i) =>
                        <div className={`bp-rec-line ${coverageClass(styleCover(r.style), settings.totalTargetWeeks ?? settings.targetWeeks)}`} key={`${r.style}:${i}`}>
                            <span className={`bp-week-sku ${beerStyleClass(r.style).className}`}><b>{displayStyle(r.style)}</b></span>
                            <span>בישול {r.sizeLabel} · מתאים למיכל {r.tankNumber}<small> · זמין מ־{shortDate(r.availableDate)}</small></span>
                        </div>) : <small>אין כרגע המלצת בישול נוספת.</small>}'''
new = '''                    {visibleBrewRecommendations().length ? visibleBrewRecommendations().map((r, i) =>
                        <div className={`bp-rec-line ${coverageClass(styleCover(r.style), settings.totalTargetWeeks ?? settings.targetWeeks)}`} key={`${r.style}:${i}`}>
                            <span className={`bp-week-sku ${beerStyleClass(r.style).className}`}><b>{displayStyle(r.style)}</b></span>
                            <span>בישול {r.sizeLabel} · מתאים למיכל {r.tankNumber}<small> · זמין מ־{shortDate(r.availableDate)}</small></span>
                        </div>) : <small>אין כרגע המלצת בישול נוספת.</small>}'''
assert old in text, 'recommendation render anchor not found'
text = text.replace(old, new, 1)

weekly.write_text(text, encoding='utf-8')

text = gantt.read_text(encoding='utf-8')
old = '''    const plannedItems: SummaryItem[] = decisions.map((item, index) => {
      const product = productFor(item.productId);
      const tank = tanks.find((candidate) => candidate.id === item.tankId);
      // Canonical tankId (aligned from brewId/cycle) wins over the historical
      // tankNumber snapshot. The snapshot is only a legacy/display fallback.
      const resolvedTank = tank?.number ?? item.tankNumber;
      return {
        key: `pack:${item.id ?? index}`,
        title: product ? `${displayStyle(product.style)} · ${tankLabel(resolvedTank)}` : item.productId,
        meta: product ? `${fmt(item.quantity)} ${product.type === "crates" ? "ארגזים" : "חביות"} · ${fmt(packageLiters(item.quantity, product.type))} ל׳ · מתוכנן` : fmt(item.quantity),
        styleClass: product ? beerStyleClass(product.style).className : undefined,
      };
    });'''
new = '''    const plannedItems: SummaryItem[] = decisions.map((item, index) => {
      const product = productFor(item.productId);
      const tank = tanks.find((candidate) => candidate.id === item.tankId);
      // Canonical tankId (aligned from brewId/cycle) wins over the historical
      // tankNumber snapshot. The snapshot is only a legacy/display fallback.
      const resolvedTank = tank?.number ?? item.tankNumber;
      const style = product?.style ?? item.nonInventoryStyle ?? "";
      const type = product?.type ?? item.nonInventoryType;
      return {
        key: `pack:${item.id ?? index}`,
        title: style ? `${displayStyle(style)} · ${tankLabel(resolvedTank)}` : item.productId,
        meta: type
          ? `${fmt(item.quantity)} ${type === "crates" ? "ארגזים" : "חביות"} · ${fmt(packageLiters(item.quantity, type))} ל׳ · מתוכנן`
          : fmt(item.quantity),
        styleClass: style ? beerStyleClass(style).className : undefined,
      };
    });'''
assert old in text, 'PlanningGantt plannedItems anchor not found'
text = text.replace(old, new, 1)

old = '''    const plannedPackaging = (plan?.packaging ?? []).reduce((sum, run) => {
      const product = productFor(run.productId);
      return sum + (product && run.quantity > 0 ? packageLiters(run.quantity, product.type) : 0);
    }, 0);'''
new = '''    const plannedPackaging = (plan?.packaging ?? []).reduce((sum, run) => {
      const product = productFor(run.productId);
      const type = product?.type ?? run.nonInventoryType;
      return sum + (type && run.quantity > 0 ? packageLiters(run.quantity, type) : 0);
    }, 0);'''
assert old in text, 'PlanningGantt weeklyTotals anchor not found'
text = text.replace(old, new, 1)

gantt.write_text(text, encoding='utf-8')
