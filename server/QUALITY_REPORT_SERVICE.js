// Quality module for the EXISTING Apps Script deployment, with an HMAC-only action.
// Do not change the authentication requirement for any other doPost action.
const Q_PROJECT = 'fermenter-dashboard-bada3';
const Q_SHEET_ID = '19urjK3mUk1vO1clZ2IFDq-3ORqLeX5edBLmBeDwIud4';
const Q_MEDIA_ROOT = '1FrGg-gBKRyCSsw4EHTq8qb6zJEpWaQSn';
const Q_SHEET_NAME = 'גיליון1';
// Email notifications disabled until a standalone mail gateway is commissioned.
// Never auto-backfill notifications for reports received while disabled.
const Q_HEADERS = ['מספר אירוע','טלפון המדווח','קישורים למדיה','מזהה שליחה',
  'תאריך ושעת דיווח','סטטוס התראה','מקור הדיווח'];
const Q_FIELDS = 'https://firestore.googleapis.com/v1/projects/'+Q_PROJECT+'/databases/(default)/documents';
const Q_MAX_PER_RUN = 8;
const Q_MAX_ATTEMPTS = 8;

/**
 * Web App executes as its deployed-by account (USER_DEPLOYING).
 * Email is deliberately not sent by this worker.
 * Calls must be HMAC-signed by the Firebase Cloud Function with a fresh
 * timestamp and a UUID. The signing key is only in Apps Script Properties
 * and Firebase Secret Manager, not in browser code.
 */

function qualityVerifyCurrentProject() {
  // Verify resources with the CURRENT manual execution credentials.
  // Run as the Web App's actual deploying account before deployment.
  // Avoid Session.getEffectiveUser(): it needs the unrelated userinfo.email scope.
  const secret=PropertiesService.getScriptProperties().getProperty('QUALITY_WEBHOOK_SECRET');
  if(!secret||secret.length<48)throw new Error('QUALITY_WEBHOOK_SECRET must be at least 48 characters');
  const sheet=SpreadsheetApp.openById(Q_SHEET_ID).getSheetByName(Q_SHEET_NAME);
  if(!sheet)throw new Error('Quality spreadsheet not accessible');
  sheet.getRange('A4').getValue();
  DriveApp.getFolderById(Q_MEDIA_ROOT).getName();
  qQuery_('queued',1);
  console.log('Quality resource access verified; mail notifications are disabled.');
}
function qHex_(bytes){
  return bytes.map(x=>('0'+(x<0?x+256:x).toString(16)).slice(-2)).join('');
}
function qSignature_(secret,message){
  return qHex_(Utilities.computeHmacSha256Signature(message,secret));
}
function qConstantTimeEqual_(a,b){
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let diff=0;
  for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

function qualityHandleSignedDispatch_(body) {
  // This public Web App performs no action without a valid signed payload.
  // Never log the signature, key or raw contact information.
  try{
    if(!body || typeof body!=='object' || Object.keys(body).length>6)return {ok:false,code:'invalid_payload'};
    const id=String(body.id||'');
    const timestamp=Number(body.timestamp);
    const signature=String(body.signature||'');
    if(!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(id)||
       !Number.isSafeInteger(timestamp)||Math.abs(Date.now()-timestamp)>120000||
       !/^[0-9a-f]{64}$/i.test(signature))return ({ok:false});
    const secret=PropertiesService.getScriptProperties().getProperty('QUALITY_WEBHOOK_SECRET');
    if(!secret||secret.length<48)return ({ok:false});
    const directMedia=Array.isArray(body.media)?body.media:[];
    if(directMedia.length>4||directMedia.some(f=>!f||typeof f.name!=='string'||typeof f.mimeType!=='string'||typeof f.base64!=='string'||f.base64.length>20000000))return ({ok:false});
    const mediaHash=directMedia.length?qHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(directMedia))):'';
    const expected=qSignature_(secret,String(timestamp)+'.'+id+(mediaHash?'.'+mediaHash:''));
    if(!qConstantTimeEqual_(expected,signature))return ({ok:false});

    const lock=LockService.getScriptLock();
    if(!lock.tryLock(10000))return ({ok:true,queued:true});
    try{
      const path=Q_FIELDS+'/qualitySubmissions/'+encodeURIComponent(id);
      const doc=JSON.parse(qFetch_(path).getContentText());
      const status=qValue_(doc.fields?.status);
      if(status==='completed')return ({
        ok:true,queued:false,ticket:qValue_(doc.fields.ticket),eventId:qValue_(doc.fields.eventId)
      });
      if(status!=='queued'&&status!=='transfer')return ({ok:true,queued:true});
      if(status==='transfer'&&!directMedia.length)return ({ok:false,retry:true,code:'missing_media'});
      try{
        const result=qProcess_(doc,directMedia);
        return ({ok:true,queued:false,ticket:result.ticket,eventId:result.eventId});
      }catch(error){
        // A write or file transfer may fail after claiming the submission; return it
        // to the private queue so the same ID can be retried safely.
        console.error('Quality processing error: '+String(error.message).slice(0,180));
        const attempts=Number(qValue_(doc.fields?.attempts)||0)+1;
        try{qPatch_(doc.name,{
          status:attempts>=Q_MAX_ATTEMPTS?'dead':status,
          attempts,lastError:String(error.message).slice(0,180),processingAt:null
        },null)}catch(requeue){console.error('Quality requeue failed: '+requeue.message)}
        return ({ok:false,retry:true,code:'processing_failed'});
      }
    }finally{lock.releaseLock()}
  }catch(error){
    console.error('Quality signed dispatch failed: '+String(error?.message||error).slice(0,190));
    // The Firestore claim remains queued / processing for safe recovery.
    return ({ok:false,retry:true,code:'dispatch_failed'});
  }
}


/** Manual recovery only. Ordinary reports are processed immediately by doPost. */
function qualityRecoverQueued() {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000))return;
  try{
    qRescueStale_();
    qQuery_('queued',Q_MAX_PER_RUN).forEach(doc=>{
      try{qProcess_(doc)}
      catch(error){
        console.error('Quality recovery failed: '+String(error.message).slice(0,180));
        const attempts=Number(qValue_(doc.fields.attempts)||0)+1;
        try{qPatch_(doc.name,{status:attempts>=Q_MAX_ATTEMPTS?'dead':'queued',
          attempts,lastError:String(error.message).slice(0,180),processingAt:null},null)}
        catch(e){console.error('Requeue failed: '+e.message)}
      }
    });
  }finally{lock.releaseLock()}
}

function qFetch_(url,options) {
  const opt=Object.assign({muteHttpExceptions:true},options||{});
  opt.headers=Object.assign({'Authorization':'Bearer '+ScriptApp.getOAuthToken()},opt.headers||{});
  const r=UrlFetchApp.fetch(url,opt);
  if(r.getResponseCode()<200||r.getResponseCode()>=300){
    throw new Error('Google REST '+r.getResponseCode()+' '+r.getContentText().slice(0,400));
  }
  return r;
}
function qValue_(field){
  if(!field)return null;
  if(Object.prototype.hasOwnProperty.call(field,'stringValue'))return field.stringValue;
  if(Object.prototype.hasOwnProperty.call(field,'integerValue'))return Number(field.integerValue);
  if(Object.prototype.hasOwnProperty.call(field,'booleanValue'))return field.booleanValue;
  if(Object.prototype.hasOwnProperty.call(field,'timestampValue'))return field.timestampValue;
  if(Object.prototype.hasOwnProperty.call(field,'nullValue'))return null;
  if(field.mapValue)return Object.fromEntries(Object.entries(field.mapValue.fields||{})
    .map(([k,v])=>[k,qValue_(v)]));
  if(field.arrayValue)return (field.arrayValue.values||[]).map(qValue_);
  return null;
}
function qTyped_(value) {
  if(value===null||value===undefined)return {nullValue:null};
  if(typeof value==='string')return {stringValue:value};
  if(typeof value==='number')return {integerValue:String(Math.floor(value))};
  if(typeof value==='boolean')return {booleanValue:value};
  throw new Error('Unsupported patch field type');
}
function qQuery_(status,limit) {
  const query={structuredQuery:{from:[{collectionId:'qualitySubmissions'}],
    where:{fieldFilter:{field:{fieldPath:'status'},op:'EQUAL',value:{stringValue:status}}},
    limit}};
  const r=qFetch_(Q_FIELDS+':runQuery',{method:'post',contentType:'application/json',payload:JSON.stringify(query)});
  return JSON.parse(r.getContentText()).map(x=>x.document).filter(Boolean);
}
function qPatch_(name,changes,updateTime){
  const parts=Object.keys(changes).map(k=>'updateMask.fieldPaths='+encodeURIComponent(k));
  if(updateTime)parts.push('currentDocument.updateTime='+encodeURIComponent(updateTime));
  const body={fields:Object.fromEntries(Object.entries(changes).map(([k,v])=>[k,qTyped_(v)]))};
  return JSON.parse(qFetch_('https://firestore.googleapis.com/v1/'+name+'?'+parts.join('&'),{
    method:'patch',contentType:'application/json',payload:JSON.stringify(body)
  }).getContentText());
}
function qRescueStale_() {
  const now=Date.now();
  qQuery_('processing',20).forEach(doc=>{
    const started=Date.parse(String(qValue_(doc.fields.processingAt)||''));
    // Every worker execution is shorter than 6 minutes; give a 15-minute lease.
    if(Number.isFinite(started)&&now-started>15*60*1000) {
      try{qPatch_(doc.name,{status:'queued',processingAt:null},doc.updateTime)}
      catch(error){console.log('Could not rescue '+doc.name+': '+error.message)}
    }
  });
}
function qNormalize_(v) {
  return String(v||'').normalize('NFKC').trim().toLowerCase()
    .replace(/[\u200e\u200f]/g,'').replace(/[\s"'׳״.,\-_/\\]+/g,' ');
}
function qDate_(iso) {
  return Utilities.formatDate(new Date(iso), 'Asia/Jerusalem','dd/MM/yyyy');
}
function qParseDate_(raw) {
  const m=String(raw||'').match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if(!m)return null;
  const now=new Date();
  let year=m[3]?(m[3].length===2?2000+Number(m[3]):Number(m[3])):now.getFullYear();
  let date=new Date(year,Number(m[2])-1,Number(m[1]));
  if(!m[3]&&date.valueOf()>now.valueOf()+86400000)date=new Date(year-1,Number(m[2])-1,Number(m[1]));
  return date;
}
function qInferIssue_(description) {
  const d=qNormalize_(description);
  if(/מקציפ|קצף|גאשינג|גשינג/.test(d))return 'הקצפת יתר';
  if(/טעם/.test(d))return 'טעם חריג';
  if(/ריח/.test(d))return 'ריח חריג';
  if(/משקע|עכור/.test(d))return 'משקעים / עכירות';
  if(/פקק|אריז|נזיל|תווית/.test(d))return 'בעיה באריזה';
  return 'אחר';
}
function qReadSheet_() {
  const sheet=SpreadsheetApp.openById(Q_SHEET_ID).getSheetByName(Q_SHEET_NAME);
  if(!sheet)throw new Error('Missing quality sheet tab');
  // One-time physical column migration: preserves original cells, notes and formulas.
  // V -> J (issue type); X -> L (package); Y -> M (SKU).
  if(sheet.getRange('J4').getDisplayValue()!=='סוג התקלה') {
    if(sheet.getRange('V4').getDisplayValue()!=='סוג התקלה' ||
       sheet.getRange('X4').getDisplayValue()!=='סוג האריזה' ||
       sheet.getRange('Y4').getDisplayValue()!=='מק"ט')
      throw new Error('Quality sheet layout requires manual inspection');
    const full=sheet.getMaxRows();
    sheet.moveColumns(sheet.getRange(1,22,full,1),10);
    sheet.moveColumns(sheet.getRange(1,24,full,1),12);
    sheet.moveColumns(sheet.getRange(1,25,full,1),13);
  }
  if(sheet.getRange('J4').getDisplayValue()!=='סוג התקלה' ||
     sheet.getRange('K4').getDisplayValue()!=='תיאור התקלה' ||
     sheet.getRange('L4').getDisplayValue()!=='סוג האריזה' ||
     sheet.getRange('M4').getDisplayValue()!=='מק"ט')
    throw new Error('Quality sheet migration verification failed');
  const headers=sheet.getRange(4,24,1,7).getDisplayValues()[0];
  if(headers.some((v,i)=>v&&v!==Q_HEADERS[i]))throw new Error('X:AD column headers conflict');
  if(headers.some((v,i)=>v!==Q_HEADERS[i]))sheet.getRange(4,24,1,7).setValues([Q_HEADERS]);
  const last=Math.max(5,sheet.getLastRow());
  const rows=last>=6?sheet.getRange(6,1,last-5,30).getDisplayValues():[];
  return {sheet,rows,last};
}
function qFindExisting_(rows,id) {
  return rows.find(row=>String(row[26]||'').trim()===id)||null;
}
function qIdentifyEvent_(rows,report) {
  // Only exact SKU + batch matches identify the same incident, regardless of
  // customer, issue type or reporting date. Never merge missing SKU/batch.
  const sku=qNormalize_(report.sku), batch=qNormalize_(report.batch);
  if(sku&&batch){
    for(let i=rows.length-1;i>=0;i--){
      const row=rows[i];
      if(qNormalize_(row[12])===sku && qNormalize_(row[4])===batch)
        return String(row[23]||('LEGACY-'+row[0]));
    }
  }
  const maxEvent=rows.reduce((max,row)=>{
    const m=String(row[23]||'').match(/^INC-(\d+)$/);
    return Math.max(max,m?Number(m[1]):0);
  },0);
  return 'INC-'+String(maxEvent+1).padStart(4,'0');
}
function qBatchIncidents_(rows,report,eventId) {
  const sku=qNormalize_(report.sku),batch=qNormalize_(report.batch);
  if(!sku||!batch)return 0;
  const matching=rows.filter(row=>row[0]&&qNormalize_(row[12])===sku&&qNormalize_(row[4])===batch);
  return matching.length+1;
}
function qMedia_(jobId,data) {
  if(!data.media||!data.media.length)return [];
  const parent=DriveApp.getFolderById(Q_MEDIA_ROOT);
  const folderName='פנייה '+jobId;
  const existing=parent.getFoldersByName(folderName);
  const folder=existing.hasNext()?existing.next():parent.createFolder(folderName);
  const links=[];
  data.media.forEach((file,i)=>{
    const name=String(i+1).padStart(2,'0')+'-'+String(file.name||'attachment')
      .replace(/[\/\\]/g,'_').slice(0,100);
    const found=folder.getFilesByName(name);
    let saved;
    if(found.hasNext())saved=found.next();
    else{
      if(typeof file.base64!=='string'||file.base64.length>20000000)throw new Error('Missing signed attachment bytes');
      const bytes=Utilities.base64Decode(file.base64);
      const blob=Utilities.newBlob(bytes,file.mimeType,name);
      saved=folder.createFile(blob);
    }
    links.push(saved.getUrl());
  });
  return links;
}

const Q_EMAILJS_SERVICE='service_bxs22rp';
const Q_EMAILJS_TEMPLATE='template_3suohm9';
const Q_EMAILJS_PUBLIC='xcE_CHJqkvlh2b_S3';
const Q_NOTIFY_TO='yisrael@atlow.co.il';
function qEscapeHtml_(value) {
  return String(value===null||value===undefined?'':value)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
/**
 * Best-effort, never backfills old reports. Script Properties are private to the
 * existing script editors, not the browser. Mark "sending" before calling EmailJS
 * so a timeout cannot silently trigger a duplicate send on the next invocation.
 * An ambiguous send requires manual reconciliation against EmailJS History.
 */
function qNotifyNewReport_(docName,rowNumber,report,mediaLinks,ticket,eventId,incidents) {
  const sheet=SpreadsheetApp.openById(Q_SHEET_ID).getSheetByName(Q_SHEET_NAME);
  const statusCell=sheet.getRange(rowNumber,29);
  const props=PropertiesService.getScriptProperties();
  const enabled=props.getProperty('QUALITY_EMAILJS_ENABLED')==='true';
  const key=props.getProperty('QUALITY_EMAILJS_PRIVATE_KEY');
  if(!enabled||!key){
    statusCell.setValue('מייל מושבת'+(incidents>=3?' · 3+ פניות ('+incidents+')':''));
    return;
  }
  const present=String(statusCell.getDisplayValue()||'');
  if(/^מייל (נשלח|בשליחה|כשל|דורש בדיקה)/.test(present))return;
  statusCell.setValue('מייל בשליחה');
  SpreadsheetApp.flush();
  // Keep the existing {{message}} template readable even before the dedicated
  // {{{htmlMessage}}} HTML template is configured in EmailJS.
  const ticketLabel='#'+String(ticket);
  const warning=incidents>=3?'⚠️ התראת אצווה: '+incidents+' פניות מאותו מק״ט ואצווה':'';
  const fields=[
    ['מספר פנייה',ticketLabel],
    ['מספר אירוע',eventId],
    ['לקוח',report.customer],
    ['מדווח',report.reporter],
    ['טלפון',report.phone||'—'],
    ['בירה',report.beer],
    ['סוג אריזה',report.packageType],
    ['מק״ט',report.sku||'—'],
    ['מספר אצווה',report.batch||'—'],
    ['תאריך תפוגה',report.expiry?String(report.expiry).split('-').reverse().join('/'):'—'],
    ['כמות',report.quantity||'—'],
    ['סוג תקלה',report.type],
    ['תיאור התקלה',report.description]
  ];
  const plain=[
    'מבשלת שפירא | בקרת איכות',
    'התקבלה פנייה חדשה '+ticketLabel,
    ...(warning?[warning]:[]),
    '',
    ...fields.map(([label,value])=>label+': '+String(value===null||value===undefined?'':value)),
    ...(mediaLinks.length?['','קבצים מצורפים (קישורים ל־Drive):',...mediaLinks.map((url,i)=>(i+1)+'. '+url)]:[])
  ].join('\n');
  const fieldRows=fields.map(([label,value])=>
    '<tr><td style="border-bottom:1px solid #eee2d5;padding:10px 12px;color:#806a5b;vertical-align:top;white-space:nowrap">'+qEscapeHtml_(label)+'</td>'+
    '<td style="border-bottom:1px solid #eee2d5;padding:10px 12px;font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere">'+qEscapeHtml_(value)+'</td></tr>'
  ).join('');
  const links=mediaLinks.map((url,i)=>
    '<li style="margin:6px 0"><a style="color:#a4432f" href="'+qEscapeHtml_(url)+'">פתיחת קובץ '+(i+1)+' ב־Google Drive</a></li>'
  ).join('');
  const html='<div dir="rtl" style="background:#faf6ef;padding:24px;font-family:Arial,sans-serif;color:#382b25;line-height:1.7">'+
    '<div style="max-width:640px;margin:auto;background:#fff;border:1px solid #e6d6bf;border-radius:14px;overflow:hidden">'+
    '<div style="background:#332a24;color:#fff;padding:23px">'+
    '<div style="font-size:14px;color:#f3d3a6">מבשלת שפירא | בקרת איכות</div>'+
    '<h2 style="margin:6px 0 0;font-size:22px;color:#fff">פנייה חדשה '+qEscapeHtml_(ticketLabel)+'</h2></div>'+
    (warning?'<div style="background:#fff0e9;color:#a32c19;padding:16px 22px;font-weight:bold">'+qEscapeHtml_(warning)+'</div>':'')+
    '<table role="presentation" dir="rtl" style="border-collapse:collapse;width:100%;font-size:14px">'+fieldRows+'</table>'+
    (links?'<div style="padding:14px 22px"><b>קבצים ותמונות</b><ul style="padding-right:18px">'+links+'</ul></div>':'')+
    '<div style="padding:15px 22px;background:#f8efe2;color:#786352;font-size:12px">התראה אוטומטית ממערכת בקרת האיכות • אין להשיב למייל זה</div>'+
    '</div></div>';
  const payload={
    service_id:Q_EMAILJS_SERVICE,template_id:Q_EMAILJS_TEMPLATE,user_id:Q_EMAILJS_PUBLIC,
    accessToken:key,template_params:{
      toEmail:Q_NOTIFY_TO,email:Q_NOTIFY_TO,resEmail:Q_NOTIFY_TO,
      title:(warning?'⚠️ ':'')+'דיווח איכות '+ticketLabel+' | '+String(report.beer||'').slice(0,80),
      message:plain,htmlMessage:html
    }
  };
  try{
    const response=UrlFetchApp.fetch('https://api.emailjs.com/api/v1.0/email/send',{
      method:'post',contentType:'application/json',payload:JSON.stringify(payload),muteHttpExceptions:true
    });
    if(response.getResponseCode()!==200)throw new Error('EmailJS HTTP '+response.getResponseCode());
    statusCell.setValue('מייל נשלח'+(incidents>=3?' · 3+ פניות ('+incidents+')':''));
    qPatch_(docName,{notificationStatus:'sent',notifiedAt:new Date().toISOString()},null);
    console.log('Quality email delivered for ticket #'+ticket);
  }catch(e){
    // Delivery may have happened before a timeout. Never automatically replay.
    statusCell.setValue('מייל דורש בדיקה');
    try{qPatch_(docName,{notificationStatus:'uncertain'},null)}catch(ignored){}
    console.error('Quality EmailJS status uncertain for ticket #'+ticket+': '+String(e.message).slice(0,100));
  }
}
function qProcess_(doc,inlineMedia) {
  const id=doc.name.split('/').pop();
  // Optimistic claim guarantees only one processor can enter a document.
  const claimed=qPatch_(doc.name,{status:'processing',processingAt:new Date().toISOString()},doc.updateTime);
  const data=Object.fromEntries(Object.entries(doc.fields||{}).map(([k,v])=>[k,qValue_(v)]));
  if(Array.isArray(inlineMedia)&&inlineMedia.length)data.media=inlineMedia;
  const report=data.report;
  if(!report||!report.customer||!report.beer)throw new Error('Malformed queued report');
  const state=qReadSheet_();
  let row=qFindExisting_(state.rows,id);
  let eventId,number,incidents,links=[],createdNew=false;
  if(row){
    eventId=String(row[23]);number=String(row[0]);
    incidents=qBatchIncidents_(state.rows.filter(x=>x!==row),report,eventId);
    links=String(row[25]||'').split('\n').filter(Boolean);
  }else{
    createdNew=true;
    // Google Drive is idempotent by stable folder + filename.
    links=qMedia_(id,data);
    number=String(state.rows.reduce((mx,r)=>Math.max(mx,Number(r[0])||0),0)+1);
    eventId=qIdentifyEvent_(state.rows,report);
    incidents=qBatchIncidents_(state.rows,report,eventId);
    const newRow=new Array(30).fill('');
    newRow[0]=number;newRow[2]=report.customer;newRow[3]=report.beer;newRow[4]=report.batch||'';
    newRow[5]=report.expiry?qDate_(report.expiry+'T12:00:00Z'):'';
    newRow[6]=report.quantity?report.quantity+' '+(report.packageType==='חבית'?'חביות':'בקבוקים'):'';
    newRow[7]=qDate_(data.submittedAt||new Date().toISOString());
    newRow[8]=report.reporter;newRow[9]=report.type;newRow[10]=report.description;
    newRow[11]=report.packageType;newRow[12]=report.sku||'';
    newRow[23]=eventId;newRow[24]=report.phone||'';
    newRow[25]=links.join('\n');newRow[26]=id;
    newRow[27]=data.submittedAt||'';
    newRow[28]='מייל מושבת'+(incidents>=3?' · 3+ תקלות באצווה ('+incidents+')':'');
    newRow[29]='טופס אינטרנטי';
    state.sheet.getRange(Math.max(6,state.last+1),1,1,30).setValues([newRow]);
    SpreadsheetApp.flush();
  }
  // Mail notifications are disabled: completion depends on durable Sheets/Drive storage only.
  // The later standalone gateway must opt in new submissions explicitly, not replay history.
  qPatch_(doc.name,{status:'completed',processingAt:null,completedAt:new Date().toISOString(),
    ticket:number,eventId,batchIncidentCount:incidents,notificationStatus:'disabled',
    report:null,media:null,lastError:null},null);
  if(createdNew){
    try{qNotifyNewReport_(doc.name,Math.max(6,state.last+1),report,links,number,eventId,incidents)}
    catch(error){console.error('Quality notification failed after completed report: '+String(error.message).slice(0,120))}
  }
  console.log('Completed quality report '+id+' / ticket #'+number);
  return {ticket:number,eventId};
}
