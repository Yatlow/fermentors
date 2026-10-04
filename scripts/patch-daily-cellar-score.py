from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:80]!r}")
    file.write_text(text.replace(old, new, 1))


health = "src/SERVICES/dashboard/healthModel.ts"
replace_once(
    health,
    " * - actionable cellar recommendations add unresolved weighted units to the\n *   denominator. When the recommendation is handled and disappears, those\n *   unresolved units disappear too and the score rises.\n",
    " * - actionable cellar recommendations add unresolved weighted units to the\n *   denominator. When the recommendation is handled and disappears, those\n *   unresolved units disappear too and the score rises;\n * - pending calendar/routine cellar actions add the same low-priority weight\n *   they earn when completed, so an unfinished Sunday routine can no longer\n *   leave the index near 100.\n",
)
replace_once(
    health,
    "    completedActions: CompletedHealthAction[] = []\n): number {",
    "    completedActions: CompletedHealthAction[] = [],\n    pendingDailyActionCount = 0\n): number {",
)
replace_once(
    health,
    "    const completedActionWeight = completedActions.reduce(\n        (sum, action) => sum + healthActionPoints(action.importance),\n        0\n    );\n\n    const possible = measurementPossible + unresolvedRecommendationWeight + completedActionWeight;",
    "    const completedActionWeight = completedActions.reduce(\n        (sum, action) => sum + healthActionPoints(action.importance),\n        0\n    );\n    // Routine calendar actions are intentionally low priority (importance 1).\n    // Completed yeast/carb actions already enter completedActions with this same\n    // +2 weight, so an unfinished routine contributes the matching two unearned\n    // points instead of being invisible to the index.\n    const pendingDailyActionWeight =\n        Math.max(0, Math.floor(Number(pendingDailyActionCount) || 0)) * healthActionPoints(1);\n\n    const possible =\n        measurementPossible +\n        unresolvedRecommendationWeight +\n        completedActionWeight +\n        pendingDailyActionWeight;",
)

dashboard = "src/components/dashboard/HealthDashboard.tsx"
replace_once(
    dashboard,
    "type DailyCellarAction = {\n    id: string;\n    tankNumber: string;\n    title: string;\n    detail?: string;\n};",
    "type DailyCellarAction = {\n    id: string;\n    tankNumber: string;\n    title: string;\n    detail?: string;\n    /** False when the same physical action is already represented by a scored recommendation. */\n    scoreEligible?: boolean;\n};",
)
replace_once(
    dashboard,
    "                                title: \"בדיקת גיזוז\",\n                                detail: sundayColdAction\n                                    ? \"פעולת יום ראשון לכל מיכל קר\"\n                                    : \"מתוכנן לרדת בשבוע הבא\",\n                            });",
    "                                title: \"בדיקת גיזוז\",\n                                detail: sundayColdAction\n                                    ? \"פעולת יום ראשון לכל מיכל קר\"\n                                    : \"מתוכנן לרדת בשבוע הבא\",\n                                // Wednesday/scheduled/natural carb work is already\n                                // represented in scoreRecommendations. Only add a\n                                // separate score unit for the standalone Sunday routine.\n                                scoreEligible: sundayColdAction && !naturalCarb && !scheduledCarbAction,\n                            });",
)
replace_once(
    dashboard,
    "                                title: \"הורדת שמרים\",\n                                detail: sundayColdAction\n                                    ? \"פעולת יום ראשון לכל מיכל קר\"\n                                    : \"מתוכנן לרדת בשבוע הבא\",\n                            });",
    "                                title: \"הורדת שמרים\",\n                                detail: sundayColdAction\n                                    ? \"פעולת יום ראשון לכל מיכל קר\"\n                                    : \"מתוכנן לרדת בשבוע הבא\",\n                                // Thursday/scheduled/natural yeast work is already\n                                // scored as a recommendation. The pure Sunday routine\n                                // needs its own low-priority score unit.\n                                scoreEligible: sundayColdAction && !naturalYeast && !scheduledYeastAction,\n                            });",
)
replace_once(
    dashboard,
    "    const healthScore = useMemo(\n        () => calculateCellarHealthScore(\n            analysis.scoreRecommendations,\n            analysis.measurementProgress,\n            analysis.completedActions\n        ),\n        [analysis.scoreRecommendations, analysis.measurementProgress, analysis.completedActions]\n    );",
    "    const pendingDailyScoreActionCount = useMemo(\n        () => analysis.dailyActions.filter((action) => action.scoreEligible !== false).length,\n        [analysis.dailyActions]\n    );\n\n    const healthScore = useMemo(\n        () => calculateCellarHealthScore(\n            analysis.scoreRecommendations,\n            analysis.measurementProgress,\n            analysis.completedActions,\n            pendingDailyScoreActionCount\n        ),\n        [\n            analysis.scoreRecommendations,\n            analysis.measurementProgress,\n            analysis.completedActions,\n            pendingDailyScoreActionCount,\n        ]\n    );",
)

tests = "tests/health-dashboard-model.test.ts"
file = Path(tests)
text = file.read_text()
addition = '''\n\ntest("pending daily routine action carries the same low-priority weight as completing it earns", () => {\n    const measurements = [\n        { missingFields: [], requiredFieldCount: 2, completedFieldCount: 2 },\n    ];\n\n    const pending = calculateCellarHealthScore([], measurements, [], 1);\n    const completed = calculateCellarHealthScore([], measurements, [{ importance: 1 }], 0);\n\n    assert.equal(pending, 50);\n    assert.equal(completed, 100);\n});\n\ntest("multiple unfinished daily routine actions accumulate in the denominator", () => {\n    const score = calculateCellarHealthScore(\n        [],\n        [{ missingFields: [], requiredFieldCount: 4, completedFieldCount: 4 }],\n        [],\n        2,\n    );\n\n    assert.equal(score, 50);\n});\n'''
marker = 'test("completed cellar actions add earned action credit", () => {'
if text.count(marker) != 1:
    raise SystemExit("health dashboard test insertion anchor missing")
file.write_text(text.replace(marker, addition + "\n" + marker, 1))
