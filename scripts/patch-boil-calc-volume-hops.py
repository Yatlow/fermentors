from pathlib import Path

path = Path('src/components/brewing/BrewFormStepper.tsx')
text = path.read_text()
old = '''  async function applyBoilRecommendation() {\n    if (boilRecommendation === null) return;\n    const value = String(roundToFive(boilRecommendation));\n    setBoilCalcOpen(false);\n    setLocal("kettleVolume", value);\n    await commitSugar("kettleVolume", value, 38, "C");\n  }\n'''
new = '''  async function applyBoilRecommendation() {\n    if (boilRecommendation === null) return;\n    const value = String(roundToFive(boilRecommendation));\n\n    // Applying the lautering boil-volume calculator is an explicit request to\n    // use this value as the kettle volume. Commit it through the same path as\n    // the boil-step input and force all recipe hop doses to be recalculated\n    // from the newly calculated volume. Avoid setLocal()+commitSugar() here:\n    // those back-to-back state writes can race and leave the boil view on the\n    // previous execution snapshot.\n    await commitSugar("kettleVolume", value, 38, "C", {\n      skipHopPrompt: true,\n      forceHopRecalc: true,\n    });\n    setBoilCalcOpen(false);\n  }\n'''
if old not in text:
    raise SystemExit('applyBoilRecommendation block not found')
path.write_text(text.replace(old, new, 1))
