import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { ArrowLeft, ArrowRight, Beer, CheckCircle2, Camera, FileImage, Package, Send, ShieldCheck, UploadCloud, X } from 'lucide-react'
import './ReportPage.css'
import shapiroLogo from '../assets/shpiro.jpeg'

const styles = ['IPA', 'פייל אייל', 'לאגר', 'הופי לאגר', 'חיטה', 'סטאוט', 'בירה מיוחדת']
const issues = [{label:'הקצפת יתר',icon:'🫧'}, {label:'טעם חריג',icon:'👅'}, {label:'ריח חריג',icon:'👃'}, {label:'בעיה באריזה',icon:'📦'}, {label:'משקעים / עכירות',icon:'🔍'}, {label:'אחר',icon:'⋯'}]
const packages = ['חבית','בקבוק'] as const
type FormFields = { customer:string; reporter:string; phone:string; beer:string; specialBeer:string; issueType:string; description:string; batch:string; expiry:string; quantity:string; packageType:string }
const emptyForm:FormFields = {customer:'',reporter:'',phone:'',beer:'',specialBeer:'',issueType:'',description:'',batch:'',expiry:'',quantity:'',packageType:''}
type Turnstile={render:(node:HTMLElement,config:Record<string,unknown>)=>string;reset:(id?:string)=>void;remove:(id:string)=>void}
declare global { interface Window { turnstile?:Turnstile } }
const siteKey=(import.meta.env.VITE_QUALITY_TURNSTILE_SITE_KEY || '') as string
const apiUrl=(import.meta.env.VITE_QUALITY_API_URL ||
  'https://europe-west1-fermenter-dashboard-bada3.cloudfunctions.net/qualityReport') as string
const maxFile=14*1024*1024, maxTotal=22*1024*1024
const allowedMedia = new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm'])
const sizeLabel=(n:number)=>n>1048576?(n/1048576).toFixed(1)+' MB':Math.round(n/1024)+' KB'

function Captcha({ onToken }: { onToken:(value:string)=>void }){
  const element=useRef<HTMLDivElement>(null)
  useEffect(()=>{
    if(!siteKey)return
    let widget:string|undefined
    let cancelled=false
    let script:HTMLScriptElement|null=null
    const show=()=>{
      if(cancelled||!element.current||!window.turnstile)return
      widget=window.turnstile.render(element.current,{sitekey:siteKey,language:'he',action:'quality-report',theme:'light',
        callback:(value:unknown)=>onToken(String(value)),
        'expired-callback':()=>onToken(''),
        'error-callback':()=>onToken('')})
    }
    if(window.turnstile) show()
    else {
      script=document.querySelector<HTMLScriptElement>('script[data-quality-turnstile]')
      if(!script){script=document.createElement('script');script.dataset.qualityTurnstile='yes';script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;document.head.appendChild(script)}
      script.addEventListener('load',show)
    }
    return()=>{cancelled=true;script?.removeEventListener('load',show);if(widget)window.turnstile?.remove(widget)}
  },[onToken])
  return siteKey?<div className="q-turnstile" ref={element}/>:<p className="q-error">אימות האבטחה טרם הוגדר, ולכן שליחת הדיווח אינה זמינה.</p>
}

export default function ReportPage(){
  const [form,setForm]=useState<FormFields>(emptyForm)
  const [step,setStep]=useState(0)
  const [attachments,setAttachments]=useState<File[]>([])
  const [captchaToken,setCaptchaToken]=useState('')
  const [error,setError]=useState('')
  const [sending,setSending]=useState(false)
  const [result,setResult]=useState<{ticket:number,eventId:string}|null>(null)
  const id=useRef(crypto.randomUUID())
  const onCaptcha=useCallback((token:string)=>setCaptchaToken(token),[])
  const set=(key:keyof FormFields,value:string)=>{setForm(f=>({...f,[key]:value}));setError('')}
  useEffect(()=>{document.title='דיווח תקלה | שפירא - Shapiro'},[])
  const validate=(index:number)=>{
    if(index===0){
      if(!form.customer.trim()||!form.reporter.trim()||!form.beer||(form.beer==='בירה מיוחדת'&&!form.specialBeer.trim())) return 'צריך למלא את שם הלקוח, שם המדווח והבירה.'
      if(form.phone.trim()&&!/^[+0-9()\s-]{6,30}$/.test(form.phone.trim())) return 'מספר הטלפון אינו תקין.'
    }
    if(index===1&&!form.issueType) return 'יש לבחור את סוג התקלה.'
    if(index===1&&!form.packageType) return 'יש לבחור סוג אריזה: חבית או בקבוק.'
    if(index===1&&!form.description.trim())return 'יש לתאר את התקלה.'
    return ''
  }
  const goNext=()=>{
    const issue=validate(step)
    if(issue){setError(issue);return}
    setStep(Math.min(2,step+1));setError('');window.scrollTo({top:0,behavior:'smooth'})
  }
  const selectFiles=(event:ChangeEvent<HTMLInputElement>)=>{
    const added=Array.from(event.target.files||[])
    event.target.value=''
    const next=[...attachments,...added]
    if(next.length>4){setError('אפשר לצרף עד ארבעה קבצים.');return}
    if(next.some(f=>!allowedMedia.has(f.type))){setError('אפשר לצרף תמונות JPEG, PNG, WEBP, HEIC או סרטונים MP4, MOV, WEBM בלבד.');return}
    if(next.some(f=>f.size>maxFile)||next.reduce((sum,f)=>sum+f.size,0)>maxTotal){setError('עד 14MB לקובץ ו־22MB לכל הדיווח.');return}
    setAttachments(next);setError('')
  }
  const submit=async()=>{
    const invalid=validate(0)||validate(1)
    if(invalid){setError(invalid);return}
    if(!siteKey||!captchaToken){setError('יש להשלים את בדיקת האבטחה.');return}
    if(sending)return
    setSending(true);setError('')
    try{
      const body=new FormData()
      const values={...form,beer:form.beer==='בירה מיוחדת'?form.specialBeer:form.beer}
      for(const [k,v] of Object.entries(values)){if(k!=='specialBeer')body.append(k,v)}
      body.append('turnstileToken',captchaToken)
      body.append('submissionId',id.current)
      attachments.forEach(file=>body.append('files',file,file.name))
      const response=await fetch(apiUrl,{method:'POST',body,credentials:'omit'})
      const data=await response.json().catch(()=>({}))
      if(!response.ok)throw new Error(data.error||'לא הצלחנו לשלוח כרגע. אפשר לנסות שוב.')
      setResult({ticket:data.ticket,eventId:data.eventId})
    }catch(cause){
      setError(cause instanceof Error?cause.message:'אירעה תקלה בשליחה.')
      setCaptchaToken('');window.turnstile?.reset()
    }finally{setSending(false)}
  }
  const reset=()=>{id.current=crypto.randomUUID();setForm(emptyForm);setStep(0);setAttachments([]);setError('');setCaptchaToken('');setResult(null)}
  return <div className="q-site" dir="rtl">
    <div className="q-glow q-glow-a"/><div className="q-glow q-glow-b"/>
    <header className="q-top"><div className="q-top-inner"><div className="q-logo"><span className="q-logo-image"><img src={shapiroLogo} alt="לוגו מבשלת שפירא"/></span><div className="q-brand-title">מבשלת שפירא <span aria-hidden="true">—</span> <strong>מחלקת בקרת איכות</strong></div></div><span className="q-safe"><ShieldCheck size={17}/> טופס דיווח</span></div></header>
    <main className="q-wrap">
      <section className="q-hero">
        <div className="q-overline">SHAPIRO · QUALITY CONTROL</div>
        <h1>דיווח על <strong>תקלה בבירה</strong></h1>
        <p>נתקלתם בתקלה באחד ממוצרי שפירא? מלאו את פרטי המקרה כדי שנוכל לבדוק ולטפל בו.</p>
        <div className="q-mini"><span/> הדיווח מועבר לצוות בקרת האיכות · ללא התחברות</div>
      </section>
      {result?<section className="q-card q-done" aria-live="polite">
        <div className="q-done-icon"><CheckCircle2 size={45}/></div>
        <div className="q-pill">הדיווח נקלט</div>
        <h2>תודה, הפנייה נרשמה</h2>
        <p>הפרטים נשמרו ונשלחו למעקב צוות האיכות.</p>
        <div className="q-ticket"><small>מספר הפנייה</small><b>#{String(result.ticket).padStart(4,'0')}</b><span>כדאי לשמור למעקב</span></div>
        <button className="q-primary" type="button" onClick={reset}>דיווח נוסף <ArrowLeft size={20}/></button>
      </section>:<section className="q-card">
        <div className="q-card-top"><div><div className="q-eyebrow">פרטי הדיווח</div><h2>{['לקוח ומוצר','פרטי התקלה','צירוף מדיה ושליחה'][step]}</h2></div><span className="q-count">0{step+1} / 03</span></div>
        <div className="q-progress" role="progressbar" aria-valuemin={1} aria-valuemax={3} aria-valuenow={step+1}><div style={{width:((step+1)/3*100)+'%'}}/></div>
        {step===0&&<div className="q-fields">
          <div className="q-section"><span>01</span><div><h3>פרטי הפנייה</h3><p>פרטי העסק, המדווח והמוצר</p></div></div>
          <label className="q-field"><span>שם הלקוח / העסק <i>*</i></span><input required value={form.customer} onChange={e=>set('customer',e.target.value)} maxLength={120} autoComplete="organization" placeholder="למשל: החור השחור, כפר חרוב"/></label>
          <div className="q-two">
            <label className="q-field"><span>מי מדווח? <i>*</i></span><input value={form.reporter} onChange={e=>set('reporter',e.target.value)} maxLength={120} placeholder="השם שלך" autoComplete="name"/></label>
            <label className="q-field"><span>טלפון <em>לא חובה</em></span><input value={form.phone} onChange={e=>set('phone',e.target.value)} maxLength={30} placeholder="שנוכל לחזור אליכם" inputMode="tel" autoComplete="tel"/></label>
          </div>
          <div className="q-field"><span>באיזו בירה מדובר? <i>*</i></span><div className="q-beers">{styles.map(beer=><button key={beer} type="button" aria-pressed={form.beer===beer} className={'q-option '+(form.beer===beer?'selected':'')} onClick={()=>set('beer',beer)}><Beer size={19}/>{beer}</button>)}</div></div>
          {form.beer==='בירה מיוחדת'&&<label className="q-field"><span>שם הבירה המיוחדת <i>*</i></span><input value={form.specialBeer} onChange={e=>set('specialBeer',e.target.value)} placeholder="מה שם הבירה?" maxLength={80}/></label>}
        </div>}
        {step===1&&<div className="q-fields">
          <div className="q-section"><span>02</span><div><h3>מה התקלה?</h3><p>המידע יסייע לצוות להבין את המקרה</p></div></div>
          <div className="q-field"><span>סוג התקלה <i>*</i></span><div className="q-problems">{issues.map(x=><button key={x.label} type="button" aria-pressed={form.issueType===x.label} className={'q-problem '+(form.issueType===x.label?'selected':'')} onClick={()=>set('issueType',x.label)}><b>{x.icon}</b>{x.label}</button>)}</div></div>
          <label className="q-field"><span>מה קרה? <i>*</i></span><textarea value={form.description} onChange={e=>set('description',e.target.value)} maxLength={2000} rows={5} placeholder="מה קרה, מתי, ובאיזה אופן התקלה באה לידי ביטוי?"/><small>{form.description.length}/2000 תווים</small></label>
          <div className="q-two">
            <label className="q-field"><span>מספר אצווה</span><input value={form.batch} onChange={e=>set('batch',e.target.value)} maxLength={50} placeholder="למשל 1532"/></label>
            <label className="q-field"><span>תאריך תפוגה</span><input type="date" value={form.expiry} onChange={e=>set('expiry',e.target.value)}/></label>
          </div>
          <div className="q-two">
            <label className="q-field"><span>כמות בירה תקולה</span><input value={form.quantity} onChange={e=>set('quantity',e.target.value)} maxLength={120} placeholder="למשל 3 חביות"/></label>
            <div className="q-field"><span>סוג האריזה <i>*</i></span><div className="q-packages" role="group" aria-label="סוג האריזה">{packages.map(p=><button type="button" key={p} className={'q-package '+(form.packageType===p?'selected':'')} aria-pressed={form.packageType===p} onClick={()=>set('packageType',p)}>{p==='חבית'?<Beer size={21}/>:<Package size={21}/>}<span>{p}</span></button>)}</div></div>
          </div>
        </div>}
        {step===2&&<div className="q-fields">
          <div className="q-section"><span>03</span><div><h3>תמונות או סרטון</h3><p>אפשר לצרף תיעוד שיסייע בבדיקת התקלה (לא חובה)</p></div></div>
          <label className="q-upload"><UploadCloud size={35}/><b>צרפו תמונה או וידאו</b><span>אפשר גם לצלם ישירות מהטלפון</span><small>עד 4 קבצים · 14MB לקובץ · 22MB סה״כ</small><input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm" multiple onChange={selectFiles}/></label>
          {attachments.length>0&&<ul className="q-files">{attachments.map((file,i)=><li key={file.name+i}>{file.type.startsWith('video')?<Camera size={19}/>:<FileImage size={19}/>}<div><b>{file.name}</b><small>{sizeLabel(file.size)}</small></div><button type="button" aria-label={'הסר '+file.name} onClick={()=>setAttachments(all=>all.filter((_,j)=>j!==i))}><X size={18}/></button></li>)}</ul>}
          <div className="q-review"><strong><CheckCircle2 size={20}/> סיכום הפנייה</strong><p>{form.customer} · {form.beer==='בירה מיוחדת'?form.specialBeer:form.beer}</p><p>{form.issueType}{form.batch?' · אצווה '+form.batch:''}</p></div>
          <div className="q-privacy"><ShieldCheck size={20}/> המדיה נשמרת בתיקיית אבטחת האיכות ונגישה לבעלי ההרשאה המתאימה.</div>
          <Captcha onToken={onCaptcha}/>
        </div>}
        {error&&<div className="q-error" role="alert">{error}</div>}
        <div className="q-actions">
          {step>0&&<button className="q-back" type="button" disabled={sending} onClick={()=>{setStep(step-1);setError('')}}><ArrowRight size={20}/> חזרה</button>}
          <button className="q-primary" type="button" disabled={sending||(step===2&&!siteKey)} onClick={step===2?()=>{void submit()}:goNext}>{sending?'שולחים...':step===2?'שליחת דיווח':'ממשיכים'}{step===2?<Send size={19}/>:<ArrowLeft size={19}/>}</button>
        </div>
      </section>}
      <footer className="q-footer">מבשלת שפירא · מחלקת בקרת איכות</footer>
    </main>
  </div>
}
