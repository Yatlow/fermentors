import {useEffect,useRef,useState,type ChangeEvent} from 'react'
import {ArrowLeft,ArrowRight,Beer,Camera,CheckCheck,CheckCircle2,ChevronLeft,FileImage,Heart,ShieldCheck,Sparkles,UploadCloud,X} from 'lucide-react'
import logo from '../assets/shpiro.jpeg'
import './ReportPage.css'

const BEERS=['IPA','פייל אייל','לאגר','הופי לאגר','חיטה','סטאוט','בירה מיוחדת']
const PROBLEMS=[
  {name:'הקצפת יתר',icon:'🫧'},{name:'טעם חריג',icon:'😵'},
  {name:'ריח חריג',icon:'👃'},{name:'בעיה באריזה',icon:'📦'},
  {name:'משקעים / עכירות',icon:'🔍'},{name:'אחר',icon:'✨'},
]
const PACKAGES=['חבית','בקבוק','פחית','אחר','לא ידוע']
type FormState={customer:string;beer:string;specialBeer:string;reporter:string;phone:string;issueType:string;batch:string;expiry:string;quantity:string;packageType:string;description:string}
const initial:FormState={customer:'',beer:'',specialBeer:'',reporter:'',phone:'',issueType:'',batch:'',expiry:'',quantity:'',packageType:'לא ידוע',description:''}
type TurnstileWidget = {render:(target:HTMLElement,options:Record<string,unknown>)=>string;remove:(id:string)=>void;reset:(id?:string)=>void}
declare global {interface Window {turnstile?:TurnstileWidget}}
const key=import.meta.env.VITE_QUALITY_TURNSTILE_SITE_KEY as string|undefined
const MAX_FILES=4,MAX_FILE_SIZE=14*1024*1024,MAX_TOTAL=22*1024*1024
const prettySize=(n:number)=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.round(n/1024)+' KB'

function Turnstile({onToken}:{onToken:(token:string)=>void}){
  const node=useRef<HTMLDivElement>(null)
  useEffect(()=>{
    if(!key||!node.current)return
    let id:string|undefined
    let cancelled=false
    const render=()=>{
      if(cancelled||!node.current||!window.turnstile)return
      id=window.turnstile.render(node.current,{sitekey:key,action:'quality-report',theme:'light',language:'he',
        callback:(value:unknown)=>onToken(String(value)),
        'expired-callback':()=>onToken(''),
        'error-callback':()=>onToken('')})
    }
    if(window.turnstile){render()}
    else{
      let script=document.querySelector<HTMLScriptElement>('script[data-quality-turnstile]')
      if(!script){script=document.createElement('script');script.dataset.qualityTurnstile='true';script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;document.head.appendChild(script)}
      script.addEventListener('load',render)
    }
    return ()=>{cancelled=true;if(id&&window.turnstile)window.turnstile.remove(id)}
  },[onToken])
  if(!key)return <p className="qr-unconfigured" role="alert">טופס הדיווח נמצא בהקמה. אימות האבטחה טרם הופעל.</p>
  return <div className="qr-turnstile" ref={node} aria-label="אימות אבטחה נגד ספאם"/>
}

export default function ReportPage(){
  const [data,setData]=useState<FormState>(initial)
  const [step,setStep]=useState(0)
  const [files,setFiles]=useState<File[]>([])
  const [token,setToken]=useState('')
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const [success,setSuccess]=useState<{ticket:number;eventId:string}|null>(null)
  const submissionId=useRef(crypto.randomUUID())
  const set=(field:keyof FormState,value:string)=>{setData(p=>({...p,[field]:value}));setError('')}
  useEffect(()=>{document.title='דיווח תקלה בבירה | שפירא'},[])
  const validateStep=(target:number)=>{
    if(target===0){
      if(!data.customer.trim()||!data.reporter.trim()||!data.beer||(data.beer==='בירה מיוחדת'&&!data.specialBeer.trim()))return 'צריך למלא את שם העסק, שם המדווח וסוג הבירה.'
      if(data.phone.trim()&&!/^[+0-9()\s-]{6,30}$/.test(data.phone.trim()))return 'מספר הטלפון אינו תקין.'
    }
    if(target===1){
      if(!data.issueType||!data.description.trim())return 'צריך לבחור סוג תקלה ולספר לנו מה קרה.'
      if(data.description.length>2000)return 'תיאור התקלה ארוך מדי (עד 2000 תווים).'
    }
    return ''
  }
  const next=()=>{const problem=validateStep(step);if(problem){setError(problem);return}setError('');setStep(s=>Math.min(2,s+1));window.scrollTo({top:0,behavior:'smooth'})}
  const addFiles=(event:ChangeEvent<HTMLInputElement>)=>{
    const incoming=Array.from(event.target.files||[])
    const all=[...files,...incoming]
    event.target.value=''
    if(all.length>MAX_FILES){setError('אפשר לצרף עד ארבעה קבצים.');return}
    const types=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm'])
    if(all.some(f=>!types.has(f.type))){setError('אפשר לצרף תמונות JPEG, PNG, WEBP, HEIC או וידאו MP4, MOV, WEBM.');return}
    if(all.some(f=>f.size>MAX_FILE_SIZE)||all.reduce((n,f)=>n+f.size,0)>MAX_TOTAL){setError('עד 14MB לקובץ ו־22MB לכלל הקבצים.');return}
    setFiles(all);setError('')
  }
  const submit=async()=>{
    const issue=validateStep(0)||validateStep(1)
    if(issue){setError(issue);return}
    if(!key||!token){setError('יש להשלים את בדיקת האבטחה לפני השליחה.');return}
    if(saving)return
    setSaving(true);setError('')
    try{
      const form=new FormData()
      const fields={...data,beer:data.beer==='בירה מיוחדת'?data.specialBeer:data.beer}
      Object.entries(fields).forEach(([name,value])=>{if(name!=='specialBeer')form.append(name,value)})
      files.forEach(file=>form.append('files',file,file.name))
      form.append('submissionId',submissionId.current)
      form.append('turnstileToken',token)
      const response=await fetch('/api/quality-report',{method:'POST',body:form,credentials:'omit'})
      const result=await response.json().catch(()=>({}))
      if(!response.ok)throw new Error(result.error||'שליחת הטופס נכשלה. אפשר לנסות שוב.')
      setSuccess({ticket:result.ticket,eventId:result.eventId})
    }catch(err){setError(err instanceof Error?err.message:'אירעה שגיאה. נסו שוב.');setToken('');window.turnstile?.reset()}
    finally{setSaving(false)}
  }
  const restart=()=>{setData(initial);setStep(0);setFiles([]);setToken('');setError('');setSuccess(null);submissionId.current=crypto.randomUUID()}
  return <div className="qr-page" dir="rtl">
    <div className="qr-orb qr-orb-one"/><div className="qr-orb qr-orb-two"/>
    <header className="qr-nav"><div className="qr-nav-inner">
      <div className="qr-brand"><span className="qr-brand-icon"><Beer size={24}/></span><span><b>SHAPIRO</b><small>QUALITY DESK</small></span></div>
      <span className="qr-nav-label"><ShieldCheck size={16}/> דיווח מהיר ובטוח</span>
    </div></header>
    <main className="qr-shell">
      <section className="qr-hero">
        <span className="qr-sticker qr-sticker-one">✦</span><span className="qr-sticker qr-sticker-two">✳</span>
        <div className="qr-eyebrow"><Sparkles size={15}/> WE CARE ABOUT EVERY SIP</div>
        <h1>משהו בבירה <span>לא זרם?</span><span className="qr-bubble">🫧</span></h1>
        <p>אנחנו פה בשביל זה. כמה פרטים קטנים, ואנחנו כבר נדאג לבדוק מה קרה.</p>
        <div className="qr-hero-note"><span className="qr-dot"/> לוקח רק כמה דקות · לא צריך להתחבר</div>
      </section>
      {success ? <section className="qr-card qr-success" aria-live="polite">
        <div className="qr-success-icon"><CheckCheck size={44}/></div>
        <div className="qr-tag">קיבלנו!</div><h2>הדיווח בדרך לטיפול 🍻</h2>
        <p>תודה שעזרת לנו לשמור על הבירה שלנו במיטבה. הצוות קיבל את הפרטים.</p>
        <div className="qr-ticket"><small>מספר הפנייה שלך</small><strong>#{String(success.ticket).padStart(4,'0')}</strong><span>אפשר לשמור את המספר למעקב</span></div>
        <button className="qr-button qr-button-primary" type="button" onClick={restart}>דיווח נוסף <ArrowLeft size={18}/></button>
      </section> : <section className="qr-card">
        <div className="qr-progress-header"><div><div className="qr-overline">LET'S FIX THIS</div><h2>{['נתחיל בהיכרות 👋','בואו נבין מה קרה 🔎','כמעט סיימנו! 📸'][step]}</h2></div><span className="qr-step-counter">0{step+1} / 03</span></div>
        <div className="qr-progress" role="progressbar" aria-valuenow={step+1} aria-valuemin={1} aria-valuemax={3} aria-label="התקדמות בטופס"><span style={{width:((step+1)/3*100)+'%'}}/></div>
        {step===0 && <div className="qr-fields">
          <div className="qr-section-title"><span>01</span><div><h3>מי מדווח ומה שותים?</h3><p>נזהה את העסק ואת הבירה המדוברת</p></div></div>
          <label className="qr-field"><span>שם לקוח / עסק <i>*</i></span><input autoComplete="organization" maxLength={120} placeholder="למשל: החור השחור, כפר חרוב" value={data.customer} onChange={e=>set('customer',e.target.value)}/></label>
          <label className="qr-field"><span>שם המדווח <i>*</i></span><input autoComplete="name" maxLength={120} placeholder="איך קוראים לך?" value={data.reporter} onChange={e=>set('reporter',e.target.value)}/></label>
          <label className="qr-field"><span>מספר טלפון <em>לא חובה</em></span><input autoComplete="tel" inputMode="tel" maxLength={30} placeholder="רק אם תרצו שנחזור אליכם" value={data.phone} onChange={e=>set('phone',e.target.value)}/></label>
          <div className="qr-field"><span>איזו בירה? <i>*</i></span><div className="qr-beer-grid">{BEERS.map(beer=><button type="button" key={beer} className={'qr-beer '+(data.beer===beer?'selected':'')} onClick={()=>set('beer',beer)} aria-pressed={data.beer===beer}><Beer size={20}/>{beer}</button>)}</div></div>
          {data.beer==='בירה מיוחדת'&&<label className="qr-field"><span>שם הבירה המיוחדת <i>*</i></span><input maxLength={80} placeholder="איך קוראים לבירה?" value={data.specialBeer} onChange={e=>set('specialBeer',e.target.value)}/></label>}
        </div>}
        {step===1&&<div className="qr-fields">
          <div className="qr-section-title"><span>02</span><div><h3>ספרו לנו מה השתבש</h3><p>כל פרט עוזר לנו להגיע לתשובה</p></div></div>
          <div className="qr-field"><span>סוג התקלה <i>*</i></span><div className="qr-problem-grid">{PROBLEMS.map(p=><button key={p.name} className={'qr-problem '+(data.issueType===p.name?'selected':'')} onClick={()=>set('issueType',p.name)} aria-pressed={data.issueType===p.name} type="button"><span>{p.icon}</span>{p.name}</button>)}</div></div>
          <label className="qr-field"><span>מה בדיוק קרה? <i>*</i></span><textarea maxLength={2000} rows={5} placeholder="מתי התחילה התקלה? מה ראיתם, הרגשתם או טעמתם? גם פרטים קטנים עוזרים 🙌" value={data.description} onChange={e=>set('description',e.target.value)}/><small>{data.description.length}/2000 תווים</small></label>
          <div className="qr-two-col">
            <label className="qr-field"><span>מספר אצווה</span><input maxLength={50} placeholder="למשל 1532" value={data.batch} onChange={e=>set('batch',e.target.value)}/></label>
            <label className="qr-field"><span>תאריך תפוגה</span><input type="date" value={data.expiry} onChange={e=>set('expiry',e.target.value)}/></label>
          </div>
          <div className="qr-two-col">
            <label className="qr-field"><span>כמות בירה תקולה</span><input maxLength={120} placeholder="למשל: 3 חביות" value={data.quantity} onChange={e=>set('quantity',e.target.value)}/></label>
            <label className="qr-field"><span>סוג אריזה</span><select value={data.packageType} onChange={e=>set('packageType',e.target.value)}>{PACKAGES.map(x=><option key={x}>{x}</option>)}</select></label>
          </div>
        </div>}
        {step===2&&<div className="qr-fields">
          <div className="qr-section-title"><span>03</span><div><h3>תמונה שווה אלף מילים</h3><p>לא חובה, אבל מאוד עוזר לנו להבין את התקלה</p></div></div>
          <label className="qr-dropzone"><UploadCloud size={32}/><b>אפשר לצרף תמונות וסרטונים</b><span>לבחירת קבצים או צילום מהטלפון</span><small>עד 4 קבצים · עד 14MB לקובץ · סה״כ 22MB</small><input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm" multiple onChange={addFiles}/></label>
          {files.length>0&&<ul className="qr-media-list">{files.map((file,i)=><li key={file.name+'-'+i}><div className="qr-file-icon">{file.type.startsWith('video')?<Camera size={20}/>:<FileImage size={20}/>}</div><div><b>{file.name}</b><small>{prettySize(file.size)}</small></div><button type="button" aria-label={'הסרת '+file.name} onClick={()=>setFiles(p=>p.filter((_,j)=>j!==i))}><X size={18}/></button></li>)}</ul>}
          <div className="qr-summary"><div className="qr-summary-heading"><CheckCircle2 size={20}/> הדיווח מוכן לשליחה</div><p><strong>{data.customer}</strong> · {data.beer==='בירה מיוחדת'?data.specialBeer:data.beer}</p><p>{data.issueType}{data.batch?' · אצווה '+data.batch:''}</p></div>
          <div className="qr-security"><ShieldCheck size={19}/><span>הקבצים והפרטים יגיעו לצוות האיכות בלבד ולא יפורסמו לציבור.</span></div>
          <Turnstile onToken={setToken}/>
        </div>}
        {error&&<div className="qr-error" role="alert">{error}</div>}
        <div className="qr-actions">
          {step>0&&<button type="button" className="qr-button qr-back" onClick={()=>{setStep(s=>s-1);setError('')}}><ArrowRight size={18}/> חזרה</button>}
          <button type="button" className="qr-button qr-button-primary" disabled={saving||(step===2&&!key)} onClick={step===2?()=>{void submit()}:next}>{saving?'שולחים את הדיווח...':step===2?'שליחת הדיווח':'ממשיכים'} {step===2?<CheckCheck size={19}/>:<ArrowLeft size={19}/>}</button>
        </div>
      </section>}
      <footer className="qr-footer"><img alt="שפירא" src={logo}/><span>BREWED WITH CARE. REPORTED WITH LOVE.</span><Heart size={14} fill="currentColor"/></footer>
    </main>
    <span className="qr-floating-beer" aria-hidden="true">🍺</span>
  </div>
}
