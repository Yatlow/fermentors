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
export function carbonationVolumes(pressurePsi: number, tempF: number): number {
  // Inverse of the ASBC/Zahm & Nagel pressure/temperature relationship.
  // Example from the photographed chart: 10 PSI at 38°F = 2.38 volumes.
  const a = -0.0684226;
  const b = 0.173354 * tempF + 4.24267;
  const c = -16.6999 - 0.0101059 * tempF + 0.00116512 * tempF * tempF - pressurePsi;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return NaN;
  const roots = [(-b + Math.sqrt(discriminant)) / (2 * a), (-b - Math.sqrt(discriminant)) / (2 * a)];
  return roots.find(v => v >= 0 && v <= 10) ?? NaN;
}

function NumberBox({label,value,onChange,unit}:{label:string;value:Num;onChange:(v:Num)=>void;unit:string}) {
  return <label className="brewCalcMiniField"><span>{label}</span><div><input type="number" step="0.1" value={value} onChange={e=>onChange(e.target.value===""?"":Number(e.target.value))}/><b>{unit}</b></div></label>;
}

export function HydrometerCorrectionCalculator({compact=false}:{compact?:boolean}) {
  const [plato,setPlato]=useState<Num>("");
  const [temp,setTemp]=useState<Num>(20);
  const result=plato!==""&&temp!==""?correctedPlato(plato,temp):null;
  return <section className={compact?"brewCalcMini compact":"spec-card brewCalcMini"}>
    {!compact&&<div className="spec-card-header"><h2>תיקון הידרומטר</h2></div>}
    <div className="brewCalcMiniGrid"><NumberBox label="פלאטו שנמדד" value={plato} onChange={setPlato} unit="°P"/><NumberBox label="טמפרטורת הדגימה" value={temp} onChange={setTemp} unit="°C"/></div>
    <div className="calc-result">פלאטו מתוקן ל־20°C: <strong>{result===null?"חסר נתון":result.toFixed(2)+"°P"}</strong></div>
    {!compact&&<small>מחושב לפי תיקון צפיפות הידרומטר סטנדרטי ב־20°C, התואם לטבלת NBS המצולמת.</small>}
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
    {!compact&&<small>לפי נוסחת האינטרפולציה המקובלת לטבלת Zahm & Nagel / ASBC שבתמונה.</small>}
    <CalculatorCss/>
  </section>;
}
export function CalculatorModal({kind,onClose,onUse}:{kind:"hydrometer"|"carbonation";onClose:()=>void;onUse?:(v:number)=>void}) {
  return <div className="brewCalcOverlay" onClick={onClose}><div className="brewCalcDialog" dir="rtl" onClick={e=>e.stopPropagation()}>
    <button type="button" className="brewCalcClose" onClick={onClose} aria-label="סגור"><X size={20}/></button>
    <h3>{kind==="hydrometer"?"תיקון הידרומטר":"מחשבון גיזוז"}</h3>
    {kind==="hydrometer"?<HydrometerCorrectionCalculator compact/>:<CarbonationReadingCalculator compact onUse={onUse}/>}
    <CalculatorCss/>
  </div></div>;
}
export function CalculatorIconButton({label,onClick}:{label:string;onClick:()=>void}) {
  return <button type="button" className="brewCalcIconButton" title={label} aria-label={label} onClick={onClick}><Calculator size={16}/><CalculatorCss/></button>;
}
function CalculatorCss(){return <style>{`.brewCalcMini{display:grid;gap:12px}.brewCalcMini.compact{padding:10px}.brewCalcMiniGrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.brewCalcMiniField{display:grid;gap:5px;font-weight:700}.brewCalcMiniField>div{display:flex;align-items:center;gap:6px}.brewCalcMiniField input{min-width:0;width:100%;max-width:150px;height:38px;border:1px solid #cbd5e1;border-radius:9px;padding:0 10px;font:inherit}.brewCalcMiniField b{white-space:nowrap;font-size:12px;color:#64748b}.brewCalcMini small{color:#64748b}.brewCalcUse{justify-self:start}.brewCalcOverlay{position:fixed;inset:0;z-index:10050;background:#0f172a66;display:flex;align-items:center;justify-content:center;padding:18px}.brewCalcDialog{position:relative;width:min(520px,100%);background:#fff;border-radius:18px;padding:22px;box-shadow:0 24px 70px #0004}.brewCalcDialog h3{margin:0 0 16px}.brewCalcClose{position:absolute;left:12px;top:12px;border:0;background:#f1f5f9;border-radius:50%;width:36px;height:36px;display:grid;place-items:center;cursor:pointer}.brewCalcIconButton{border:1px solid #cbd5e1;background:#fff;border-radius:8px;width:34px;height:34px;display:inline-grid;place-items:center;cursor:pointer;color:#245f91;vertical-align:middle}@media(max-width:520px){.brewCalcMiniGrid{grid-template-columns:1fr 1fr;gap:8px}.brewCalcMiniField input{max-width:120px}}`}</style>}
