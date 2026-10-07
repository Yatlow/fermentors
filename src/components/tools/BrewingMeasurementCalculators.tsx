import { useState } from "react";
import { Calculator, X } from "lucide-react";

type Num = number | "";

function platoToSg(plato: number): number {
  return 1 + plato / (258.6 - ((plato / 258.2) * 227.1));
}
function sgToPlato(sg: number): number {
  return -616.868 + 1111.14 * sg - 630.272 * sg * sg + 135.997 * sg * sg * sg;
}
function hydrometerFactorF(tempF: number): number {
  return 1.00130346 - 0.000134722124 * tempF + 0.00000204052596 * tempF * tempF - 0.00000000232820948 * tempF * tempF * tempF;
}
export function correctedPlato(observedPlato: number, tempC: number): number {
  const tempF = tempC * 9 / 5 + 32;
  const referenceF = 68; // the photographed NBS/ASBC table is standardized at 20°C
  const correctedSg = platoToSg(observedPlato) * hydrometerFactorF(tempF) / hydrometerFactorF(referenceF);
  return sgToPlato(correctedSg);
}
function roundCarbonationLikePrintedTable(value: number): number {
  // Printed chart convention requested by brewery: third decimal 0–5 goes down,
  // 6–9 goes up. This intentionally differs from Math.round at an exact x.xx5.
  const scaled = value * 100;
  const hundredths = Math.floor(scaled + 1e-9);
  const thirdDigit = Math.floor(value * 1000 + 1e-7) % 10;
  return (thirdDigit <= 5 ? hundredths : hundredths + 1) / 100;
}

export function carbonationVolumes(pressurePsi: number, tempF: number): number {
  // Inverse of the ASBC/Zahm & Nagel pressure/temperature relationship.
  // Example from the photographed chart: 10 PSI at 38°F = 2.38 volumes.
  const a = -0.0684226;
  const b = 0.173354 * tempF + 4.24267;
  const c = -16.6999 - 0.0101059 * tempF + 0.00116512 * tempF * tempF - pressurePsi;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return NaN;
  const roots = [(-b + Math.sqrt(discriminant)) / (2 * a), (-b - Math.sqrt(discriminant)) / (2 * a)];
  const raw = roots.find(v => v >= 0 && v <= 10) ?? NaN;
  return Number.isFinite(raw) ? roundCarbonationLikePrintedTable(raw) : raw;
}

function NumberBox({label,value,onChange,unit}:{label:string;value:Num;onChange:(v:Num)=>void;unit:string}) {
  return <label className="brewCalcMiniField"><span>{label}</span><div><input type="number" step="0.1" value={value} onChange={e=>onChange(e.target.value===""?"":Number(e.target.value))}/><b>{unit}</b></div></label>;
}

export function HydrometerCorrectionCalculator({compact=false,onUse}:{compact?:boolean;onUse?:(v:number)=>void}) {
  const [plato,setPlato]=useState<Num>("");
  const [temp,setTemp]=useState<Num>(20);
  const result=plato!==""&&temp!==""?correctedPlato(plato,temp):null;
  return <section className={compact?"brewCalcMini compact":"spec-card brewCalcMini"}>
    {!compact&&<div className="spec-card-header"><h2>תיקון הידרומטר</h2></div>}
    <div className="brewCalcMiniGrid"><NumberBox label="פלאטו שנמדד" value={plato} onChange={setPlato} unit="°P"/><NumberBox label="טמפרטורת הדגימה" value={temp} onChange={setTemp} unit="°C"/></div>
    <div className="calc-result">פלאטו מתוקן ל־20°C: <strong>{result===null?"חסר נתון":result.toFixed(2)+"°P"}</strong></div>
    {onUse&&result!==null&&<button type="button" className="btn-primary brewCalcUse" onClick={()=>onUse(result)}>השתמש בתוצאה</button>}
    <CalculatorCss/>
  </section>;
}
export function CarbonationReadingCalculator({compact=false,onUse}:{compact?:boolean;onUse?:(v:number)=>void}) {
  const [psi,setPsi]=useState<Num>("");
  const [tempF,setTempF]=useState<Num>(32);
  const result=psi!==""&&tempF!==""?carbonationVolumes(psi,tempF):null;
  return <section className={compact?"brewCalcMini compact":"spec-card brewCalcMini"}>
    {!compact&&<div className="spec-card-header"><h2>קריאת גיזוז</h2></div>}
    <div className="brewCalcMiniGrid"><NumberBox label="לחץ" value={psi} onChange={setPsi} unit="PSI"/><NumberBox label="טמפרטורה" value={tempF} onChange={setTempF} unit="°F"/></div>
    <div className="calc-result">CO₂: <strong>{result===null?"חסר נתון":result.toFixed(2)+" volumes"}</strong></div>
    {onUse&&result!==null&&<button type="button" className="btn-primary brewCalcUse" onClick={()=>onUse(result)}>השתמש בתוצאה</button>}
    <CalculatorCss/>
  </section>;
}
export function CalculatorModal({kind,onClose,onUse}:{kind:"hydrometer"|"carbonation";onClose:()=>void;onUse?:(v:number)=>void}) {
  return <div className="brewCalcOverlay" onClick={onClose}><div className="brewCalcDialog" dir="rtl" onClick={e=>e.stopPropagation()}>
    <button type="button" className="brewCalcClose" onClick={onClose} aria-label="סגור"><X size={20}/></button>
    <h3>{kind==="hydrometer"?"תיקון הידרומטר":"מחשבון גיזוז"}</h3>
    {kind==="hydrometer"?<HydrometerCorrectionCalculator compact onUse={onUse}/>:<CarbonationReadingCalculator compact onUse={onUse}/>}
    <CalculatorCss/>
  </div></div>;
}
export function CalculatorIconButton({label,onClick}:{label:string;onClick:()=>void}) {
  return <button type="button" className="brewCalcIconButton" title={label} aria-label={label} onPointerDown={e=>e.preventDefault()} onClick={onClick}><Calculator size={16}/><CalculatorCss/></button>;
}
function CalculatorCss(){return <style>{`
.brewCalcMini{display:grid;gap:14px;padding:18px}
.brewCalcMini.compact{padding:2px 0 0}
.brewCalcMiniGrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.brewCalcMiniField{display:grid;gap:6px;font-weight:700;font-size:.86rem}
.brewCalcMiniField>div{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px}
.brewCalcMiniField input{min-width:0;width:100%;height:40px;border:1px solid #cbd5e1;border-radius:10px;padding:0 10px;font:inherit;background:#fff}
.brewCalcMiniField b{white-space:nowrap;font-size:12px;color:#64748b}
.calc-result{padding:11px 12px;border-radius:11px;background:#f1f5f9;text-align:center}
.brewCalcMini small{color:#64748b}
.brewCalcUse{justify-self:stretch;min-height:42px}
.brewCalcOverlay{position:fixed;inset:0;z-index:10050;background:#0f172a66;display:flex;align-items:center;justify-content:center;padding:18px}
.brewCalcDialog{position:relative;width:min(430px,calc(100vw - 28px));background:#fff;border-radius:16px;padding:18px;box-shadow:0 24px 70px #0004}
.brewCalcDialog h3{margin:0 0 16px;padding-inline-end:38px}
.brewCalcClose{position:absolute;left:12px;top:12px;border:0;background:#f1f5f9;border-radius:50%;width:34px;height:34px;display:grid;place-items:center;cursor:pointer}
.brewCalcIconButton{border:1px solid #cbd5e1;background:#f8fafc;border-radius:8px;width:36px;height:40px;display:inline-grid;place-items:center;cursor:pointer;color:#245f91;vertical-align:middle;flex:0 0 auto}
@media(max-width:520px){.brewCalcDialog{padding:16px}.brewCalcMiniGrid{gap:8px}.brewCalcMiniField input{height:38px}.brewCalcIconButton{height:38px}}
`}</style>}
