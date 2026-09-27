from pathlib import Path

# Keep the dashboard brew form attached to the live Firestore tank object rather
# than the object snapshot that happened to be clicked when the modal opened.
dashboard = Path('src/components/dashboard/Dashboard.tsx')
text = dashboard.read_text()
marker = '''    const recipeStyles = useMemo(
        () => brewRecipes.map((recipe) => ({ id: recipe.id, style: recipe.style })),
        [brewRecipes],
    );
'''
replacement = marker + '''
    const liveBrewFormTank = useMemo(() => {
        if (!brewFormTank) return null;
        const liveTanks = healthBrews ?? filteredBrews;
        return liveTanks.find((tank) => tank.id === brewFormTank.id) ?? null;
    }, [brewFormTank, healthBrews, filteredBrews]);
'''
if replacement not in text:
    if marker not in text:
        raise SystemExit('Dashboard recipeStyles marker not found')
    text = text.replace(marker, replacement, 1)
old = '''            {brewFormTank && (
                <DashboardBrewFormModal
                    tank={brewFormTank}
                    onClose={() => setBrewFormTank(null)}
                />
            )}
'''
new = '''            {liveBrewFormTank && (
                <DashboardBrewFormModal
                    tank={liveBrewFormTank}
                    onClose={() => setBrewFormTank(null)}
                />
            )}
'''
if old not in text:
    raise SystemExit('Dashboard brew modal marker not found')
text = text.replace(old, new, 1)
dashboard.write_text(text)

# A quick-report draft is local component state. If the same physical tank moves
# to another batch/action while the popover is still open, close the unsent draft
# instead of allowing it to be submitted with the new live tank metadata.
quick = Path('src/components/dashboard/QuickTankReportBox.tsx')
text = quick.read_text()
marker = '''    const isSending = status === "sending";

    useEffect(() => {
'''
replacement = '''    const isSending = status === "sending";
    const sourceIdentity = `${tank.id}:${Number(tank.action ?? -1)}:${String(tank.batchNumber ?? "").replace("#", "").trim()}`;
    const sourceIdentityRef = useRef(sourceIdentity);

    useEffect(() => {
        if (sourceIdentityRef.current === sourceIdentity) return;
        sourceIdentityRef.current = sourceIdentity;
        if (!isSending && !packagingJob) onClose();
    }, [sourceIdentity, isSending, packagingJob, onClose]);

    useEffect(() => {
'''
if replacement not in text:
    if marker not in text:
        raise SystemExit('QuickTankReportBox effect marker not found')
    text = text.replace(marker, replacement, 1)
quick.write_text(text)

# Refresh the tank's planned-packaging badge when its batch identity changes too.
tank_card = Path('src/components/dashboard/TankCard.tsx')
text = tank_card.read_text()
old = '''  }, [tank.id, tank.tankNumber, tank.action]);
'''
new = '''  }, [tank.id, tank.tankNumber, tank.action, tank.batchNumber]);
'''
if old not in text:
    raise SystemExit('TankCard planned packaging dependencies marker not found')
tank_card.write_text(text.replace(old, new, 1))
