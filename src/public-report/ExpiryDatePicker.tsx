import { useEffect, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'

const weekdays = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש']
const months = Array.from({length:12}, (_,i)=>new Intl.DateTimeFormat('he-IL',{month:'long'}).format(new Date(2026,i,1)))
const formatDate = (day:Date) => String(day.getDate()).padStart(2,'0')+'/'+String(day.getMonth()+1).padStart(2,'0')+'/'+day.getFullYear()

function parsedDate(value:string):Date|null {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if(!match)return null
  const d=Number(match[1]),m=Number(match[2]),y=Number(match[3])
  if(y<1900||y>2200)return null
  const date=new Date(y,m-1,d)
  return date.getFullYear()===y&&date.getMonth()===m-1&&date.getDate()===d?date:null
}

function normalizeTyping(raw:string,prior:string):string {
  const digits=raw.replace(/\D/g,'').slice(0,8)
  if(!digits)return ''
  const deleting=raw.length<prior.length
  let text=digits.slice(0,2)
  if(digits.length>2)text+='/'+digits.slice(2,4)
  else if(digits.length===2&&!deleting)text+='/'
  if(digits.length>4)text+='/'+digits.slice(4)
  else if(digits.length===4&&!deleting)text+='/'
  return text
}

export default function ExpiryDatePicker({value,onChange}:{value:string;onChange:(value:string)=>void}){
  const [open,setOpen]=useState(false)
  const [view,setView]=useState(()=>{
    const d=parsedDate(value)||new Date()
    return new Date(d.getFullYear(),d.getMonth(),1)
  })
  const root=useRef<HTMLDivElement>(null)
  const input=useRef<HTMLInputElement>(null)
  const selected=parsedDate(value)
  const year=view.getFullYear(),month=view.getMonth()
  const today=new Date()
  const yearOptions=Array.from({length:26},(_,i)=>today.getFullYear()-5+i)

  useEffect(()=>{
    if(!open)return
    const closeOutside=(event:PointerEvent)=>{
      if(root.current&&!root.current.contains(event.target as Node))setOpen(false)
    }
    const closeEscape=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){setOpen(false);input.current?.focus()}
    }
    document.addEventListener('pointerdown',closeOutside)
    document.addEventListener('keydown',closeEscape)
    return ()=>{
      document.removeEventListener('pointerdown',closeOutside)
      document.removeEventListener('keydown',closeEscape)
    }
  },[open])

  const openCalendar=()=>{
    if(!open){
      const d=parsedDate(value)||new Date()
      setView(new Date(d.getFullYear(),d.getMonth(),1))
    }
    setOpen(v=>!v)
  }
  const moveMonth=(delta:number)=>setView(v=>new Date(v.getFullYear(),v.getMonth()+delta,1))
  const first=new Date(year,month,1).getDay()
  const days=new Date(year,month+1,0).getDate()
  const cells=Array.from({length:Math.ceil((first+days)/7)*7},(_,i)=>{
    const n=i-first+1
    return n>0&&n<=days?n:null
  })

  return <div ref={root} className="q-expiry-control">
    <div className="q-expiry-input">
      <input ref={input} id="q-expiry" type="text" dir="ltr" inputMode="numeric"
        placeholder="DD/MM/YYYY" autoComplete="off" aria-label="תאריך תפוגה: יום, חודש, שנה"
        value={value} onChange={e=>onChange(normalizeTyping(e.target.value,value))}
        maxLength={10}/>
      <button type="button" className="q-expiry-trigger" onClick={openCalendar}
        aria-label="פתיחת לוח השנה" aria-haspopup="dialog" aria-expanded={open}
        aria-controls="q-expiry-calendar"><CalendarDays size={20}/></button>
    </div>
    {open&&<div id="q-expiry-calendar" role="dialog" aria-label="בחירת תאריך תפוגה" className="q-expiry-popover" dir="rtl">
      <div className="q-expiry-header">
        <button type="button" onClick={()=>moveMonth(-1)} aria-label="חודש קודם"><ChevronRight size={19}/></button>
        <select aria-label="חודש" value={month} onChange={e=>setView(new Date(year,Number(e.target.value),1))}>
          {months.map((name,i)=><option key={i} value={i}>{name}</option>)}
        </select>
        <select aria-label="שנה" value={year} onChange={e=>setView(new Date(Number(e.target.value),month,1))}>
          {(yearOptions.includes(year)?yearOptions:[...yearOptions,year].sort((a,b)=>a-b)).map(y=><option key={y} value={y}>{y}</option>)}
        </select>
        <button type="button" onClick={()=>moveMonth(1)} aria-label="חודש הבא"><ChevronLeft size={19}/></button>
      </div>
      <div className="q-expiry-grid" role="grid" aria-label={months[month]+' '+year}>
        {weekdays.map((day,i)=><span className="q-expiry-weekday" key={i} aria-hidden="true">{day}</span>)}
        {cells.map((day,i)=>day===null?<span key={'empty'+i}/>:
          <button type="button" key={i}
            className={[
              selected?.getFullYear()===year&&selected?.getMonth()===month&&selected?.getDate()===day?'q-expiry-selected':'',
              today.getFullYear()===year&&today.getMonth()===month&&today.getDate()===day?'q-expiry-today':''
            ].filter(Boolean).join(' ')}
            aria-label={day+' '+months[month]+' '+year}
            aria-pressed={selected?.getFullYear()===year&&selected?.getMonth()===month&&selected?.getDate()===day}
            onClick={()=>{onChange(formatDate(new Date(year,month,day)));setOpen(false);input.current?.focus()}}>{day}</button>)}
      </div>
      <div className="q-expiry-footer">
        <button type="button" onClick={()=>{onChange('');setOpen(false);input.current?.focus()}}>נקה תאריך</button>
        <button type="button" onClick={()=>{onChange(formatDate(new Date()));setOpen(false);input.current?.focus()}}>היום</button>
      </div>
    </div>}
  </div>
}
