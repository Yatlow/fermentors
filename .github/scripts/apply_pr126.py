from pathlib import Path

def patch(path, old, new, count=1):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'missing pattern in {path}: {old[:100]!r}')
    p.write_text(s.replace(old,new,count))

def append_once(path, marker, text):
    p=Path(path); s=p.read_text()
    if marker not in s: p.write_text(s+text)

# 1,2,3,4 App integration / RBAC
p=Path('src/App.tsx'); s=p.read_text()
s=s.replace('const UserConnectionReport = lazy(() => import("./components/reports/UserConnectionReport"));', 'const UserConnectionReport = lazy(() => import("./components/reports/UserConnectionReport"));\nconst PackagingSheetGenerator = lazy(() => import("./COMPONENTS/PackagingSheetGenerator"));')
s=s.replace('    const [plannerUser, setPlannerUser] = useState(false);', '    const [plannerUser, setPlannerUser] = useState(false);\n    const [cellarManager, setCellarManager] = useState(false);')
s=s.replace('                setPlannerUser(false);\n                setLoading(false);', '                setPlannerUser(false);\n                setCellarManager(false);\n                setLoading(false);',1)
s=s.replace('                setPlannerUser(approved && userData?.isPlannerUser === true);', '                setPlannerUser(approved && userData?.isPlannerUser === true);\n                setCellarManager(approved && (userData?.isCellarManager === true || userData?.isAdmin === true));')
s=s.replace('                setPlannerUser(false);\n            } finally', '                setPlannerUser(false);\n                setCellarManager(false);\n            } finally')
s=s.replace('    return { user, loading, isApproved, admin, plannerUser };', '    return { user, loading, isApproved, admin, plannerUser, cellarManager };')
s=s.replace('    const { user, loading: authLoading, isApproved, admin, plannerUser } = useAuth();', '    const { user, loading: authLoading, isApproved, admin, plannerUser, cellarManager } = useAuth();')
s=s.replace('useState<"specs" | "calculator" | "changeBatchNumInFv" | "changeFvStatus" | "editEmails">("calculator")', 'useState<"specs" | "calculator" | "changeBatchNumInFv" | "changeFvStatus" | "editEmails" | "packagingSheet">("calculator")')
old='''                        <button type="button" className={`status-filter-button ${selectedAdminTools === "calculator" ? "active" : ""}`} onClick={() => setSelectedAdminTools("calculator")}><span>מחשבון למבשלן</span></button>\n                        <button type="button" className={`status-filter-button ${selectedAdminTools === "specs" ? "active" : ""}`} onClick={() => setSelectedAdminTools("specs")}><span>הגדרות מערכת</span></button>\n                        <button type="button" className={`status-filter-button ${selectedAdminTools === "changeBatchNumInFv" ? "active" : ""}`} onClick={() => setSelectedAdminTools("changeBatchNumInFv")}><span>שינוי אצווה במיכל- ידנית</span></button>\n                        <button type="button" className={`status-filter-button ${selectedAdminTools === "changeFvStatus" ? "active" : ""}`} onClick={() => setSelectedAdminTools("changeFvStatus")}><span>שינוי סטטוס במיכל- ידנית</span></button>\n                        <button type="button" className={`status-filter-button ${selectedAdminTools === "editEmails" ? "active" : ""}`} onClick={() => setSelectedAdminTools("editEmails")}><span>אימיילים מורשים</span></button>'''
new='''                        <button type="button" className={`status-filter-button ${selectedAdminTools === "calculator" ? "active" : ""}`} onClick={() => setSelectedAdminTools("calculator")}><span>מחשבון למבשלן</span></button>\n                        <button type="button" className={`status-filter-button ${selectedAdminTools === "packagingSheet" ? "active" : ""}`} onClick={() => setSelectedAdminTools("packagingSheet")}><span>דף אריזה להדפסה</span></button>\n                        {cellarManager && <button type="button" className={`status-filter-button ${selectedAdminTools === "specs" ? "active" : ""}`} onClick={() => setSelectedAdminTools("specs")}><span>הגדרות סלרינג</span></button>}\n                        {cellarManager && <button type="button" className={`status-filter-button ${selectedAdminTools === "changeBatchNumInFv" ? "active" : ""}`} onClick={() => setSelectedAdminTools("changeBatchNumInFv")}><span>שינוי אצווה במיכל- ידנית</span></button>}\n                        {cellarManager && <button type="button" className={`status-filter-button ${selectedAdminTools === "changeFvStatus" ? "active" : ""}`} onClick={() => setSelectedAdminTools("changeFvStatus")}><span>שינוי סטטוס במיכל- ידנית</span></button>}\n                        {admin && <button type="button" className={`status-filter-button ${selectedAdminTools === "editEmails" ? "active" : ""}`} onClick={() => setSelectedAdminTools("editEmails")}><span>משתמשים והרשאות</span></button>}'''
if old not in s: raise SystemExit('App tools pattern missing')
s=s.replace(old,new)
s=s.replace('{selectedView === "ניהול" && selectedAdminTools === "specs" && <EditSpecs isAdmin={admin} />}', '{selectedView === "ניהול" && selectedAdminTools === "specs" && cellarManager && <EditSpecs isAdmin={cellarManager} />}')
s=s.replace('{selectedView === "ניהול" && selectedAdminTools === "calculator" && <BrewCalc brews={brews} />}', '{selectedView === "ניהול" && selectedAdminTools === "calculator" && <BrewCalc brews={brews} />}\n                {selectedView === "ניהול" && selectedAdminTools === "packagingSheet" && <PackagingSheetGenerator brews={brews} specs={specs} />}')
s=s.replace('<ManualBatchAssignment brews={brews} isAdmin={admin} />','<ManualBatchAssignment brews={brews} isAdmin={cellarManager} />').replace('<ManualStatusAssignment brews={brews} isAdmin={admin} />','<ManualStatusAssignment brews={brews} isAdmin={cellarManager} />')
p.write_text(s)

# 1 celebration: only a real <100 -> 100 transition after analysis is hydrated
p=Path('src/components/dashboard/HealthDashboard.tsx'); s=p.read_text()
s=s.replace('import "./HealthDashboard.css";', 'import BeerCelebration from "../../COMPONENTS/BeerCelebration";\nimport "./HealthDashboard.css";')
needle='''    const overallClass = healthBand(healthScore);'''
insert='''    const overallClass = healthBand(healthScore);\n    const previousSettledScoreRef = useRef<number | null>(null);\n    const [celebrationOpen, setCelebrationOpen] = useState(false);\n\n    useEffect(() => {\n        if (analyzing) return;\n        const previous = previousSettledScoreRef.current;\n        if (previous !== null && previous < 100 && healthScore === 100) {\n            setCelebrationOpen(true);\n        }\n        previousSettledScoreRef.current = healthScore;\n    }, [analyzing, healthScore]);'''
if needle not in s: raise SystemExit('health score needle missing')
s=s.replace(needle,insert)
s=s.replace('''    return (\n        <section className={`health-dashboard health-${overallClass}`} dir="rtl">''','''    return (\n        <>\n        <BeerCelebration open={celebrationOpen} onClose={() => setCelebrationOpen(false)} />\n        <section className={`health-dashboard health-${overallClass}`} dir="rtl">''')
s=s.replace('''        </section>\n    );\n}''','''        </section>\n        </>\n    );\n}''')
p.write_text(s)

# 2/3 role editor
p=Path('src/components/tools/EditApprovedUsers.tsx'); s=p.read_text()
s=s.replace('''    firestoreAccessDisabled: boolean;\n};''','''    firestoreAccessDisabled: boolean;\n    isAdmin: boolean;\n    isCellarManager: boolean;\n    isPlannerUser: boolean;\n};''')
s=s.replace('''                firestoreAccessDisabled: d.data().firestoreAccessDisabled === true,\n            }));''','''                firestoreAccessDisabled: d.data().firestoreAccessDisabled === true,\n                isAdmin: d.data().isAdmin === true,\n                isCellarManager: d.data().isCellarManager === true,\n                isPlannerUser: d.data().isPlannerUser === true,\n            }));''')
s=s.replace('''[...prev, { id: docId, email, firestoreAccessDisabled: false }]''','''[...prev, { id: docId, email, firestoreAccessDisabled: false, isAdmin: false, isCellarManager: false, isPlannerUser: false }]''')
marker='''    // ============================================================\n    // REMOVE\n    // ============================================================'''
role_fn='''    const handleToggleRole = async (user: ApprovedUser, role: "isAdmin" | "isCellarManager" | "isPlannerUser") => {\n        if (!isAdmin) { setShowPermissionModal(true); return; }\n        if (role === "isAdmin" && auth.currentUser?.email?.toLowerCase() === user.id.toLowerCase() && user.isAdmin) {\n            setError("לא ניתן להסיר הרשאת אדמין מהמשתמש המחובר כעת.");\n            return;\n        }\n        const next = !user[role];\n        try {\n            setSaving(true); setError(""); setSuccess("");\n            await updateDoc(doc(db, "approvedUsers", user.id), { [role]: next });\n            setUsers((current) => current.map((item) => item.id === user.id ? { ...item, [role]: next } : item));\n            setSuccess(`ההרשאה של ${user.email} עודכנה ✓`);\n        } catch (err) {\n            console.error("Error toggling role:", err);\n            setError("אירעה שגיאה בשינוי ההרשאה");\n        } finally { setSaving(false); }\n    };\n\n'''+marker
if marker not in s: raise SystemExit('role insertion marker missing')
s=s.replace(marker,role_fn)
old='''                                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>\n                                    <button'''
new='''                                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>\n                                    <button className={`btn-primary ${user.isCellarManager ? "active" : ""}`} onClick={() => handleToggleRole(user, "isCellarManager")} disabled={saving}>מנהל סלרינג {user.isCellarManager ? "✓" : ""}</button>\n                                    <button className={`btn-primary ${user.isPlannerUser ? "active" : ""}`} onClick={() => handleToggleRole(user, "isPlannerUser")} disabled={saving}>מתכנן {user.isPlannerUser ? "✓" : ""}</button>\n                                    <button className={`btn-primary ${user.isAdmin ? "active" : ""}`} onClick={() => handleToggleRole(user, "isAdmin")} disabled={saving}>אדמין {user.isAdmin ? "✓" : ""}</button>\n                                    <button'''
if old not in s: raise SystemExit('user action row missing')
s=s.replace(old,new)
s=s.replace('ניהול משתמשים מאושרים','משתמשים והרשאות').replace('הוספה והסרה של כתובות אימייל בעלות גישה למערכת','גישה למערכת והרשאות אדמין, מנהל סלרינג ומתכנן')
p.write_text(s)

# Security rules: admin and cellar-manager are separate; admin inherits cellar powers
p=Path('firestore.rules'); s=p.read_text()
admin='''    function isAdmin() {\n      return isApprovedUser() &&\n        get(\n          /databases/$(database)/documents/approvedUsers/$(request.auth.token.email)\n        ).data.isAdmin == true;\n    }'''
manager=admin+'''\n\n    function isCellarManager() {\n      return isApprovedUser() && (isAdmin() ||\n        get(\n          /databases/$(database)/documents/approvedUsers/$(request.auth.token.email)\n        ).data.get('isCellarManager', false) == true);\n    }'''
if admin not in s: raise SystemExit('rules admin missing')
s=s.replace(admin,manager)
s=s.replace('allow list: if isApprovedUser();','allow list: if isAdmin();',1)
s=s.replace('''    match /specs/{document} {\n      allow read: if isApprovedUser();\n      allow write: if isApprovedUser();\n    }''','''    match /specs/{document} {\n      allow read: if isApprovedUser();\n      allow write: if isCellarManager();\n    }''')
p.write_text(s)

# 4 packaging sheet uses catalog SKU and SpecChart expiration values
Path('src/COMPONENTS/PackagingSheetGenerator.tsx').write_text(r'''import { useMemo, useState } from "react";
import type { Fermentor } from "../App";
import type { SpecChart } from "../SERVICES/getAndPost/getSpecsFromFb";
import { getCatalogEntry } from "../SERVICES/cooler/PalletCatalog";

type Props={brews:Fermentor[]; specs:SpecChart|null};
const isoToday=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`};
const addMonths=(iso:string,n:number)=>{const d=new Date(`${iso}T12:00:00`);d.setMonth(d.getMonth()+n);return d};
const fmt=(d:Date)=>`${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getFullYear()).slice(-2)}`;
function specStyle(style:string|undefined|null){const s=String(style||"").trim().toLowerCase();if(s.includes("ipa"))return "ipa";if(s.includes("פייל")||s.includes("pale"))return "פייל";if(s.includes("הופי")||s.includes("hoppy"))return "הופי";if(s.includes("חיטה")||s.includes("wheat"))return "חיטה";if(s.includes("לאגר")||s.includes("lager"))return "לאגר";if(s.includes("סטאוט")||s.includes("stout"))return "סטאוט";return "other"}
export default function PackagingSheetGenerator({brews,specs}:Props){const [tank,setTank]=useState("");const [kind,setKind]=useState<"crates"|"kegs">("kegs");const [date,setDate]=useState(isoToday());const brew=brews.find(b=>String(b.tankNumber)===tank);const expirySpec=specs?.bottleExpDat||{};const months=Number(kind==="crates"?(expirySpec[specStyle(brew?.beerStyle)]??expirySpec.other??6):(expirySpec.kegBBE??6))||6;const expiry=useMemo(()=>fmt(addMonths(date,months)),[date,months]);const catalog=brew?getCatalogEntry(brew.beerStyle,kind):null;return <section className="pack-sheet-tool" dir="rtl"><h2>יצירת דף אריזה</h2><div className="pack-sheet-controls"><label>מיכל / אצווה<select value={tank} onChange={e=>setTank(e.target.value)}><option value="">בחר מיכל</option>{brews.filter(b=>Number(b.tankNumber)!==1&&b.batchNumber).map(b=><option key={b.id} value={String(b.tankNumber)}>מיכל {b.tankNumber} · {b.beerStyle} · {b.batchNumber}</option>)}</select></label><label>אריזה<select value={kind} onChange={e=>setKind(e.target.value as "crates"|"kegs")}><option value="kegs">חבית</option><option value="crates">בקבוקים</option></select></label><label>תאריך אריזה<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><button className="btn-primary" disabled={!brew||!catalog} onClick={()=>window.print()}>הדפס A4 לרוחב</button></div>{brew&&<div className="pack-sheet-print"><strong>{brew.beerStyle}</strong><b>{kind==="kegs"?"חבית":"בקבוקים"}</b><b>{brew.batchNumber}</b><span>מק״ט</span><b>{catalog?.sku||"אין מק״ט בקטלוג"}</b><footer>פג תוקף {expiry}</footer></div>}<style>{`@media screen{.pack-sheet-tool{padding:24px}.pack-sheet-controls{display:flex;gap:12px;flex-wrap:wrap}.pack-sheet-controls label{display:flex;flex-direction:column;gap:4px}.pack-sheet-print{margin:30px auto;padding:60px;max-width:900px;text-align:center;border:1px solid #ddd;display:flex;flex-direction:column;font-size:44px}.pack-sheet-print strong{font-size:72px}.pack-sheet-print footer{margin-top:35px}}@media print{@page{size:A4 landscape;margin:10mm}body *{visibility:hidden!important}.pack-sheet-print,.pack-sheet-print *{visibility:visible!important}.pack-sheet-print{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;font-family:Arial,sans-serif;font-size:44pt}.pack-sheet-print strong{font-size:64pt}.pack-sheet-print footer{margin-top:28pt}}`}</style></section>}
''')

# 5 live lauter elapsed time until end transfer is entered
p=Path('src/components/brewing/BrewFormStepper.tsx'); s=p.read_text()
needle='''  function transferDurationText(): string {'''
insert='''  const [lauterClockTick, setLauterClockTick] = useState(0);\n  useEffect(() => {\n    if (currentStep.id !== "lautering" || localValue("endTransfer.start") || !localValue("outToBoil.start")) return;\n    const timer = window.setInterval(() => setLauterClockTick((value) => value + 1), 30000);\n    return () => window.clearInterval(timer);\n  }, [currentStep.id, currentBlock, fields["endTransfer.start"], fields["outToBoil.start"]]);\n\n  function liveLauterDurationText(): string {\n    void lauterClockTick;\n    if (localValue("endTransfer.start")) return "";\n    const start = localValue("outToBoil.start");\n    if (!start) return "";\n    const minutes = forwardMinutes(start, hhmmNow());\n    if (minutes === null || minutes > 8 * 60) return "";\n    return `זמן מתחילת לאוטר: ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;\n  }\n\n'''+needle
if needle not in s: raise SystemExit('lautering duration insertion missing')
s=s.replace(needle,insert)
old='''                    <strong>שטיפה {index}</strong>'''
new='''                    <strong>שטיפה {index}{index === visibleRinseCount && liveLauterDurationText() ? <small className="brew-stage-duration"> · {liveLauterDurationText()}</small> : null}</strong>'''
if old not in s: raise SystemExit('rinse strong missing')
s=s.replace(old,new,1)
p.write_text(s)

# 6 yeast minimums move from hardcode to specs with safe legacy fallback
p=Path('src/SERVICES/cellering/calculateCelleringRecomendations.ts'); s=p.read_text()
s=s.replace('const YEAST_DROP_SPECS:', 'const DEFAULT_YEAST_DROP_SPECS:')
s=s.replace('''function getYeastDropSpec(\n    beerStyle: string,\n    tankNumber: number | undefined,\n    type: YeastDropType\n): number | null {''','''function getYeastDropSpec(\n    beerStyle: string,\n    tankNumber: number | undefined,\n    type: YeastDropType,\n    givenSpecs: SpecChart\n): number | null {''')
s=s.replace('''    return YEAST_DROP_SPECS[styleKey]?.[size]?.[type] ?? null;''','''    const configured = Number(givenSpecs?.yeastDropMinimums?.[`${styleKey}_${size}_${type}`]);\n    if (Number.isFinite(configured) && configured >= 0) return configured;\n    return DEFAULT_YEAST_DROP_SPECS[styleKey]?.[size]?.[type] ?? null;''')
s=s.replace('''            "warm"\n        );''','''            "warm",\n            givenSpecs\n        );''',1)
s=s.replace('''            "cold"\n        );''','''            "cold",\n            givenSpecs\n        );''',1)
p.write_text(s)

# Specs UI: seed/edit yeast minimums, remove legacy AA doc from UI and use setDoc merge
p=Path('src/components/tools/EditSpecs.tsx'); s=p.read_text()
s=s.replace('import { doc, updateDoc } from "firebase/firestore";','import { doc, setDoc } from "firebase/firestore";')
s=s.replace('''    hops: "aa%",\n    citra_aa: "סיטרה",\n    cascade_aa: "קסקייד",\n    talos_aa: "טאלוס",''','''    yeastDropMinimums: "מינימום דליי שמרים להוצאה",\n    ipa_double_warm: "IPA כפול · חם", ipa_double_cold: "IPA כפול · קר",\n    ipa_triple_warm: "IPA משולש · חם", ipa_triple_cold: "IPA משולש · קר",\n    פייל_double_warm: "פייל כפול · חם", פייל_double_cold: "פייל כפול · קר",\n    פייל_triple_warm: "פייל משולש · חם", פייל_triple_cold: "פייל משולש · קר",\n    חיטה_single_warm: "חיטה בודד · חם", חיטה_single_cold: "חיטה בודד · קר",\n    חיטה_double_warm: "חיטה כפול · חם", חיטה_double_cold: "חיטה כפול · קר",\n    חיטה_triple_warm: "חיטה משולש · חם", חיטה_triple_cold: "חיטה משולש · קר",\n    לאגר_triple_warm: "לאגר משולש · חם", לאגר_triple_cold: "לאגר משולש · קר",\n    הופי_double_warm: "הופי כפול · חם", הופי_double_cold: "הופי כפול · קר",\n    הופי_triple_warm: "הופי משולש · חם", הופי_triple_cold: "הופי משולש · קר",\n    סטאוט_single_warm: "סטאוט בודד · חם", סטאוט_single_cold: "סטאוט בודד · קר",''')
s=s.replace('''                setSpecs(await getSpecsFromFb());''','''                const loaded = await getSpecsFromFb();\n                if (!loaded.yeastDropMinimums) {\n                    loaded.yeastDropMinimums = {\n                        ipa_double_warm:8, ipa_double_cold:8, ipa_triple_warm:12, ipa_triple_cold:12,\n                        פייל_double_warm:7, פייל_double_cold:7, פייל_triple_warm:8, פייל_triple_cold:8,\n                        חיטה_single_warm:1, חיטה_single_cold:1, חיטה_double_warm:2, חיטה_double_cold:2, חיטה_triple_warm:4, חיטה_triple_cold:4,\n                        לאגר_triple_warm:7, לאגר_triple_cold:7, הופי_double_warm:7, הופי_double_cold:5, הופי_triple_warm:7, הופי_triple_cold:6,\n                        סטאוט_single_warm:3, סטאוט_single_cold:1\n                    };\n                }\n                delete loaded.hops;\n                setSpecs(loaded);''')
s=s.replace('await updateDoc(doc(db, "specs", documentId), values);','await setDoc(doc(db, "specs", documentId), values, { merge: true });')
p.write_text(s)

# 7 AA source of truth = active/current ingredient lot, no SPECS lookup
p=Path('src/SERVICES/cellering/dryHopLogic.ts'); s=p.read_text()
s=s.replace('import type { SpecChart } from "../getAndPost/getSpecsFromFb";','import type { SpecChart } from "../getAndPost/getSpecsFromFb";\nimport { DEFAULT_INGREDIENT_LIBRARY, activeLot } from "../brewing/ingredientLibrary";')
start=s.index('/**\n * Returns the aa percentage configured in the hops document.')
end=s.index('export function isValidHopAa', start)
replacement='''/** AA source of truth: the current/active lot in the ingredient library. */\nexport function getHopAa(\n    hopType: string | null | undefined,\n    _specs?: SpecChart | null\n): number | null {\n    const normalized = String(hopType || "").trim().toLowerCase();\n    if (!normalized) return null;\n    const aliases: Record<string,string> = { talos: "talus" };\n    const key = aliases[normalized] ?? normalized;\n    const ingredient = DEFAULT_INGREDIENT_LIBRARY.find((item) =>\n        item.category === "hop" && (item.id.toLowerCase() === key || item.name.toLowerCase() === key)\n    );\n    const alpha = ingredient ? activeLot(ingredient)?.alpha : undefined;\n    return alpha !== undefined && Number.isFinite(Number(alpha)) ? Number(alpha) : null;\n}\n\n'''
s=s[:start]+replacement+s[end:]
p.write_text(s)

# 8 cleanup wired into existing 5-min maintenance (internally once/day)
p=Path('server/asyncLogTrigger.js'); s=p.read_text()
s=s.replace('''  let operationReceiptCleanup = null;\n  let styleModels = null;''','''  let operationReceiptCleanup = null;\n  let transientCleanup = null;\n  let styleModels = null;''')
s=s.replace('''  try {\n    styleModels = calculateWeeklyStyleAverages(false);''','''  try {\n    transientCleanup = cleanupTransientCollections_();\n  } catch (error) {\n    console.log("Transient collection cleanup failed: " + error.message);\n  }\n\n  try {\n    styleModels = calculateWeeklyStyleAverages(false);''')
s=s.replace('''    operationReceiptCleanup: operationReceiptCleanup,\n    styleModels: styleModels,''','''    operationReceiptCleanup: operationReceiptCleanup,\n    transientCleanup: transientCleanup,\n    styleModels: styleModels,''')
p.write_text(s)

# 9 readable event chips in Gantt week headers
p=Path('src/components/planning/PlanningGantt.tsx'); s=p.read_text()
old='''{weekHolidays.length > 0 && <small className="bp-gantt-holidays" title={weekHolidays.map((holiday) => `${shortDate(holiday.date)} · ${holiday.title}`).join("\\n")}>{weekHolidays.slice(0, 2).map((holiday) => `${shortDate(holiday.date)} · ${holiday.title}`).join(" · ")}{weekHolidays.length > 2 ? ` · +${weekHolidays.length - 2}` : ""}</small>}'''
new='''{weekHolidays.length > 0 && <div className="bp-gantt-holidays" aria-label="אירועי השבוע">{weekHolidays.slice(0, 3).map((holiday) => <span className="bp-gantt-holiday-chip" key={`${holiday.date}:${holiday.title}`}><b>{shortDate(holiday.date)}</b><span>{holiday.title}</span></span>)}{weekHolidays.length > 3 && <span className="bp-gantt-holiday-more" title={weekHolidays.slice(3).map((holiday) => `${shortDate(holiday.date)} · ${holiday.title}`).join("\\n")}>+{weekHolidays.length - 3} אירועים</span>}</div>}'''
if old not in s: raise SystemExit('gantt holiday pattern missing')
s=s.replace(old,new)
p.write_text(s)
append_once('src/App.css','.bp-gantt-holiday-chip', '''\n.bp-gantt-holidays{display:flex;flex-direction:column;gap:3px;width:100%;margin-top:4px}.bp-gantt-holiday-chip{display:grid;grid-template-columns:auto 1fr;gap:5px;align-items:start;padding:3px 6px;border-radius:7px;background:rgba(0,0,0,.055);font-size:11px;line-height:1.25;text-align:right}.bp-gantt-holiday-chip b{white-space:nowrap}.bp-gantt-holiday-chip span{overflow-wrap:anywhere}.bp-gantt-holiday-more{font-size:10px;font-weight:700;cursor:help}\n''')

print('PR126 patch applied')
