from pathlib import Path

path = Path('src/components/brewing/BrewFormStepper.tsx')
text = path.read_text()
old = '''  for (let index = 1; index <= 7; index += 1) {
    const rowOffset = 18 + (index - 1);
    const time = normalizedTime(cell(rowOffset, "E"));
    const amount = numericText(cell(rowOffset, "F"));
    const temp = numericText(cell(rowOffset, "G"));
    const volumeText = cell(rowOffset, "H");

    if (time) pulled[`rinse${index}.time`] = time;
    if (amount) pulled[`rinse${index}.amount`] = amount;
    if (temp) pulled[`rinse${index}.temp`] = temp;

    if (volumeText) {
      const parts = volumeText
        .split("+")
        .map((part) => numericText(part))
        .filter(Boolean);
      if (parts[0]) pulled[`rinse${index}.kettle`] = parts[0];
      if (usesGrant && parts[1]) {
        pulled[`rinse${index}.grant`] = parts[1];
      }
    }
  }

'''
new = '''  // Rinse rows move when a recipe has a different mash layout (for example
  // Wheat with a third rest). Never infer rinse data from fixed row offsets;
  // the semantic "שטיפה N" rows below are the only Sheet source for rinses.

'''
if old not in text:
    raise SystemExit('Expected legacy fixed-offset rinse parser was not found')
path.write_text(text.replace(old, new, 1))
