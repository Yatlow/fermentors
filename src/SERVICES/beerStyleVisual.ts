export type BeerStyleVisual = { background: string; border: string; text: string };

// Keep these identical to the long-standing inventory / cooler style palette.
export function beerStyleVisual(style: string | null | undefined): BeerStyleVisual {
  const s = String(style || "").trim().toLowerCase();
  if (s.includes("ipa")) return { background: "#b5d3fb", border: "#28578d", text: "#385196" };
  if (s.includes("פייל") || s.includes("pale")) return { background: "#a4f1bf", border: "#208b47", text: "#166534" };
  if ((s.includes("הופי") || s.includes("hoppy")) && (s.includes("לאגר") || s.includes("lager"))) return { background: "#eab365", border: "#59420f", text: "#4d2f02" };
  if (s.includes("לאגר") || s.includes("lager")) return { background: "#a3a3a3", border: "#474949", text: "#060605" };
  if (s.includes("חיטה") || s.includes("wheat")) return { background: "#fef9c3", border: "#ca8a04", text: "#433b00" };
  if (s.includes("סטאוט") || s.includes("stout")) return { background: "#f29696", border: "#b91c1c", text: "#7f1d1d" };
  if (s.includes("סאוט") || s.includes("sour")) return { background: "#fbcfe8", border: "#f472b6", text: "#9d174d" };
  return { background: "#c49cef", border: "#430b7f", text: "#361352" };
}
