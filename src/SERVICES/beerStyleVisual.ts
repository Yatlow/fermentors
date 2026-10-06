export type BeerStyleVisual = { background: string; border: string; text: string };

export function beerStyleVisual(style: string | null | undefined): BeerStyleVisual {
  const s=String(style||"").trim().toLowerCase();
  if (s.includes("ipa")) return {background:"#fff0df",border:"#f59e0b",text:"#8a4b08"};
  if (s.includes("פייל")||s.includes("pale")) return {background:"#fff7d6",border:"#eab308",text:"#715b00"};
  if (s.includes("הופי")||s.includes("hoppy")) return {background:"#e9f8df",border:"#65a30d",text:"#3f6212"};
  if (s.includes("חיטה")||s.includes("wheat")) return {background:"#fffbe8",border:"#d6b64c",text:"#6f5b13"};
  if (s.includes("לאגר")||s.includes("lager")) return {background:"#e5f4ff",border:"#3b82f6",text:"#1d4f91"};
  if (s.includes("סטאוט")||s.includes("stout")) return {background:"#eee8e2",border:"#72584a",text:"#49362d"};
  return {background:"#f1f5f9",border:"#94a3b8",text:"#475569"};
}
