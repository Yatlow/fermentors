// Quality module for the EXISTING Apps Script deployment, with an HMAC-only action.
// Do not change the authentication requirement for any other doPost action.
const Q_PROJECT = 'fermenter-dashboard-bada3';
const Q_SHEET_ID = '19urjK3mUk1vO1clZ2IFDq-3ORqLeX5edBLmBeDwIud4';
const Q_MEDIA_ROOT = '1FrGg-gBKRyCSsw4EHTq8qb6zJEpWaQSn';
const Q_SHEET_NAME = 'גיליון1';
// TEMPORARY FOR PR #252 VALIDATION. Restore yochai@shapirobeer.co.il before production cutover.
const Q_MAIL_TO = 'yisrael@atlow.co.il';
const Q_HEADERS = ['מספר אירוע','סוג התקלה','טלפון המדווח','סוג האריזה','מק"ט',
  'קישורים למדיה','מזהה שליחה','תאריך ושעת דיווח','סטטוס התראה','מקור הדיווח'];
const Q_FIELDS = 'https://firestore.googleapis.com/v1/projects/'+Q_PROJECT+'/databases/(default)/documents';
const Q_MAX_PER_RUN = 8;
const Q_MAX_ATTEMPTS = 8;

/**
 * Web App executes as brewcrew, but authorization is NEVER anonymous.
 * Calls must be HMAC-signed by the Firebase Cloud Function with a fresh
 * timestamp and a UUID. The signing key is only in Apps Script Properties
 * and Firebase Secret Manager, not in browser code.
 */

function qualityVerifyCurrentProject() {
  const who=Session.getEffectiveUser().getEmail();
  const secret=PropertiesService.getScriptProperties().getProperty('QUALITY_WEBHOOK_SECRET');
  if(!secret||secret.length<48)throw new Error('QUALITY_WEBHOOK_SECRET must be at least 48 characters');
  const sheet=SpreadsheetApp.openById(Q_SHEET_ID).getSheetByName(Q_SHEET_NAME);
  if(!sheet)throw new Error('Quality spreadsheet not accessible');
  sheet.getRange('A4').getValue();
  DriveApp.getFolderById(Q_MEDIA_ROOT).getName();
  qQuery_('queued',1);
  console.log('Quality access verified as '+who);
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
    if(!body || typeof body!=='object' || Object.keys(body).length>6)return {ok:false};
    const id=String(body.id||'');
    const timestamp=Number(body.timestamp);
    const signature=String(body.signature||'');
    if(!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(id)||
       !Number.isSafeInteger(timestamp)||Math.abs(Date.now()-timestamp)>120000||
       !/^[0-9a-f]{64}$/i.test(signature))return ({ok:false});
    const secret=PropertiesService.getScriptProperties().getProperty('QUALITY_WEBHOOK_SECRET');
    if(!secret||secret.length<48)return ({ok:false});
    const expected=qSignature_(secret,String(timestamp)+'.'+id);
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
      if(status!=='queued')return ({ok:true,queued:true});
      try{
        const result=qProcess_(doc);
        return ({ok:true,queued:false,ticket:result.ticket,eventId:result.eventId});
      }catch(error){
        // A write or email may fail after claiming the submission; return it
        // to the private queue so the same ID can be retried safely.
        console.error('Quality processing error: '+String(error.message).slice(0,180));
        const attempts=Number(qValue_(doc.fields?.attempts)||0)+1;
        try{qPatch_(doc.name,{
          status:attempts>=Q_MAX_ATTEMPTS?'dead':'queued',
          attempts,lastError:String(error.message).slice(0,180),processingAt:null
        },null)}catch(requeue){console.error('Quality requeue failed: '+requeue.message)}
        return ({ok:false,retry:true});
      }
    }finally{lock.releaseLock()}
  }catch(error){
    console.error('Quality signed dispatch failed: '+String(error?.message||error).slice(0,190));
    // The Firestore claim remains queued / processing for safe recovery.
    return ({ok:false,retry:true});
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
  const headers=sheet.getRange(4,21,1,10).getDisplayValues()[0];
  if(headers.some((v,i)=>v&&v!==Q_HEADERS[i]))throw new Error('U:AD columns are already in use');
  if(headers.some((v,i)=>v!==Q_HEADERS[i]))sheet.getRange(4,21,1,10).setValues([Q_HEADERS]);
  const last=Math.max(5,sheet.getLastRow());
  const rows=last>=6?sheet.getRange(6,1,last-5,30).getDisplayValues():[];
  return {sheet,rows,last};
}
function qFindExisting_(rows,id) {
  return rows.find(row=>String(row[26]||'').trim()===id)||null;
}
function qIdentifyEvent_(rows,report) {
  const now=Date.now(), cutoff=now-90*86400000;
  for(let i=rows.length-1;i>=0;i--){
    const row=rows[i],when=qParseDate_(row[7]);
    if(!when||when.getTime()<cutoff)continue;
    if(qNormalize_(row[2])!==qNormalize_(report.customer)||
       qNormalize_(row[3])!==qNormalize_(report.beer)||
       qNormalize_(row[4])!==qNormalize_(report.batch)||!report.batch)continue;
    if(String(row[21]||qInferIssue_(row[9]))!==report.type)continue;
    return String(row[20]||('LEGACY-'+row[0]));
  }
  const maxEvent=rows.reduce((max,row)=>{
    const m=String(row[20]||'').match(/^INC-(\d+)$/);
    return Math.max(max,m?Number(m[1]):0);
  },0);
  return 'INC-'+String(maxEvent+1).padStart(4,'0');
}
function qBatchIncidents_(rows,report,eventId) {
  if(!report.batch)return 0;
  const events=new Set([eventId]);
  rows.forEach(row=>{
    if(!row[0]||!row[2]||!row[3])return;
    if(qNormalize_(row[3])===qNormalize_(report.beer) &&
       qNormalize_(row[4])===qNormalize_(report.batch)){
      events.add(String(row[20]||('LEGACY-'+row[0])));
    }
  });
  return events.size;
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
      const url='https://storage.googleapis.com/storage/v1/b/'+encodeURIComponent(data.bucket)+
        '/o/'+encodeURIComponent(file.path)+'?alt=media';
      const blob=qFetch_(url).getBlob().setName(name).setContentType(file.mimeType);
      saved=folder.createFile(blob);
    }
    links.push(saved.getUrl());
  });
  return links;
}
function qProcess_(doc) {
  const id=doc.name.split('/').pop();
  // Optimistic claim guarantees only one processor can enter a document.
  const claimed=qPatch_(doc.name,{status:'processing',processingAt:new Date().toISOString()},doc.updateTime);
  const data=Object.fromEntries(Object.entries(doc.fields||{}).map(([k,v])=>[k,qValue_(v)]));
  const report=data.report;
  if(!report||!report.customer||!report.beer)throw new Error('Malformed queued report');
  const state=qReadSheet_();
  let row=qFindExisting_(state.rows,id);
  let eventId,number,incidents,links=[];
  if(row){
    eventId=String(row[20]);number=String(row[0]);
    incidents=qBatchIncidents_(state.rows.filter(x=>x!==row),report,eventId);
    links=String(row[25]||'').split('\n').filter(Boolean);
  }else{
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
    newRow[8]=report.reporter;newRow[9]=report.description;
    newRow[20]=eventId;newRow[21]=report.type;newRow[22]=report.phone||'';
    newRow[23]=report.packageType;newRow[24]=report.sku||'';
    newRow[25]=links.join('\n');newRow[26]=id;
    newRow[27]=data.submittedAt||'';newRow[28]=incidents>=3?'3+ תקלות באצווה ('+incidents+')':'';
    newRow[29]='טופס אינטרנטי';
    state.sheet.getRange(Math.max(6,state.last+1),1,1,30).setValues([newRow]);
    SpreadsheetApp.flush();
  }
  const countWarning=incidents>=3?'\n\n⚠️ '+incidents+' אירועי תקלה נפרדים דווחו על בירה '+report.beer+
    ' מאצווה '+report.batch+', כולל דיווח זה.':'';
  const body=['דיווח תקלה חדש · פנייה #'+number,'אירוע: '+eventId,
    'לקוח: '+report.customer,'בירה: '+report.beer,'אצווה: '+(report.batch||'לא ידועה'),
    'סוג אריזה: '+report.packageType,'סוג תקלה: '+report.type,
    'כמות: '+(report.quantity||'לא צוינה'),
    'מדווח: '+report.reporter,'טלפון: '+(report.phone||'לא סופק'),
    'תיאור: '+report.description,countWarning,
    ...links.map(url=>'מדיה: '+url),
    'גיליון: https://docs.google.com/spreadsheets/d/'+Q_SHEET_ID+'/edit'].join('\n');
  MailApp.sendEmail({to:Q_MAIL_TO,subject:'דיווח תקלה חדש · '+report.beer+' · פנייה #'+number,body});
  // Acknowledge only after the email has been accepted by MailApp.
  // Store no report/contact content permanently in the idempotency record.
  qPatch_(doc.name,{status:'completed',processingAt:null,completedAt:new Date().toISOString(),
    ticket:number,eventId,batchIncidentCount:incidents,report:null,media:null,lastError:null},null);
  // Best-effort cleanup of staged objects AFTER email + sheet persistence.
  (data.media||[]).forEach(file=>{
    try{
      const url='https://storage.googleapis.com/storage/v1/b/'+encodeURIComponent(data.bucket)+
        '/o/'+encodeURIComponent(file.path);
      qFetch_(url,{method:'delete'});
    }catch(err){console.log('Pending staged-blob cleanup '+file.path+': '+err.message)}
  });
  console.log('Completed quality report '+id+' / ticket #'+number);
  return {ticket:number,eventId};
}
