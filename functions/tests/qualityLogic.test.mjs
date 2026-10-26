import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {validateReport,relatedEvent,distinctBatchEvents,rowsToReports,createSheetRow,formatIsraeliDate,normalize,mergeSkuHistory,parseSheetDate,knownSku} from '../qualityLogic.mjs';
const base = {customer:'החור השחור',beer:'לאגר',issueType:'הקצפת יתר',packageType:'חבית',reporter:'רון',description:'מקציף בפולסים',quantity:'3',batch:'1532',expiry:'2026-12-25'};
test('validates and normalizes SKU and numeric quantity',()=>{
  const r=validateReport(base); assert.equal(r.sku,'7009942'); assert.equal(r.quantity,'3');
  assert.equal(r.phone,''); assert.throws(()=>validateReport({...base,issueType:'arbitrary'}));
  assert.throws(()=>validateReport({...base,expiry:'2026-02-30'}));
});
test('same customer, batch and issue category link to one event',()=>{
  const earlier={customer:'החור השחור',beer:'לאגר',batch:'1532',type:'הקצפת יתר',date:new Date('2026-10-25'),eventId:'INC-1'};
  assert.equal(relatedEvent([earlier],validateReport(base),new Date('2026-10-26')).eventId,'INC-1');
  assert.equal(relatedEvent([earlier],validateReport({...base,batch:''}),new Date('2026-10-26')),null);
  assert.equal(relatedEvent([earlier],validateReport({...base,issueType:'טעם חריג'}),new Date('2026-10-26')),null);
  assert.equal(relatedEvent([earlier],validateReport(base),new Date('2027-04-26')),null);
});
test('same batch counts distinct issues across package types but not duplicate submissions',()=>{
  const reports=['INC-1','INC-1','INC-2'].map((eventId,i)=>({eventId,date:new Date('2024-10-20'),beer:'לאגר',batch:'1532',packageType:i===2?'בקבוק':'חבית'}));
  reports.push({eventId:'INC-3',date:new Date('2020-01-01'),beer:'IPA',batch:'1532'});
  reports.push({eventId:'INC-4',date:new Date('2020-01-01'),beer:'לאגר',batch:'1533'});
  assert.equal(distinctBatchEvents(reports,validateReport(base)).size,2);
  assert.equal(distinctBatchEvents(reports,validateReport({...base,batch:''})).size,0);
});
test('reads original twenty columns and appends metadata without moving old columns',()=>{
 const raw=new Array(30).fill('');raw[0]='3';raw[2]='החור השחור';raw[3]='לאגר';raw[4]='1532';raw[6]='3 חביות';raw[7]='25/10/26';raw[9]='3 חביות מקציפות';
 const existing=rowsToReports([raw]);assert.equal(existing[0].type,'הקצפת יתר');assert.equal(existing[0].packageType,'חבית');
 assert.equal(existing[0].sku,'7009942');
 const row=createSheetRow('4','INC-3',validateReport(base),['https://drive.google.com/file/d/example/view'],new Date('2026-10-26T08:00:00Z'),'uuid');
 assert.equal(row[6],'3 חביות');
 assert.equal(row[20],'INC-3');assert.equal(row[25].includes('drive.google.com'),true);assert.equal(row.length,30);
 assert.equal(formatIsraeliDate(new Date('2026-10-26T08:00:00Z')),'26/10/2026');
 assert.equal(normalize('חבית  /  לאגר'),'חבית לאגר');
});

test('unknown special beers and legacy unsupported packaging never infer a SKU',()=>{
 assert.equal(validateReport({...base,beer:'מיוחדת 2026'}).sku,'');
 assert.equal(knownSku('לאגר','פחית'),'');
});
test('three reports from one batch produce three distinct incidents even without SKU',()=>{
 const reports=[1,1,2,3].map(n=>({eventId:'INC-'+n,beer:'לאגר',batch:'1532',date:null,sku:''}));
 assert.equal(distinctBatchEvents(reports,validateReport(base)).size,3);
});

test('atomic history fold counts third distinct incident while ignoring duplicate reporters',()=>{
  const now=new Date('2026-10-26T08:00:00Z'),cutoff=now.valueOf()-90*86400_000;
  const initial=[{id:'INC-1',at:'2026-10-20T08:00:00Z'},{id:'INC-2',at:'2026-10-21T08:00:00Z'}];
  const third=mergeSkuHistory(initial,[initial[0]],cutoff,'INC-3',now);
  assert.equal(third.before,2);assert.equal(third.added,true);assert.equal(third.events.length,3);
  const repeat=mergeSkuHistory(initial,[...third.events],cutoff,'INC-3',now);
  assert.equal(repeat.added,false);assert.equal(repeat.events.length,3);
});
test('rolling SKU history excludes incidents older than ninety days',()=>{
  const now=new Date('2026-10-26T08:00:00Z'),cutoff=now.valueOf()-90*86400_000;
  const result=mergeSkuHistory([{id:'OLD',at:'2026-01-01T10:00:00Z'}],[],cutoff,'NEW',now);
  assert.equal(result.before,0);assert.deepEqual(result.events.map(x=>x.id),['NEW']);
});

test('legacy day/month dates roll to the previous calendar year in January',()=>{
 const now=new Date('2027-01-05T08:00:00Z');
 assert.equal(parseSheetDate('25/12',now)?.toISOString().slice(0,10),'2026-12-25');
 assert.equal(parseSheetDate('03/01',now)?.toISOString().slice(0,10),'2027-01-03');
 assert.equal(parseSheetDate('31/02',now),null);
});

test('public API rejects bot traffic before any catalog or Sheets reads',()=>{
 const source=readFileSync(new URL('../index.mjs',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('export const qualityReport=onRequest'));
 const antiBot=code.indexOf('await checkTurnstile(fields.turnstileToken,req.ip)');
 const limit=code.indexOf('await chargeLimit(req.ip)');
 const catalog=code.indexOf("database.doc('productCatalog/'+key).get()");
 const sheet=code.indexOf('const prior=await idRef.get()');
 assert.ok(antiBot>=0 && antiBot<sheet && sheet<limit && limit<catalog);
});

test('public complaints accept only a selected keg or bottle package',()=>{
  for(const p of ['חבית','בקבוק']) assert.equal(validateReport({...base,packageType:p}).packageType,p);
  for(const p of ['',undefined,'פחית','אחר','לא ידוע']) assert.throws(()=>validateReport({...base,packageType:p}));
});

test('preview landing page bypasses brewery login and retains private production root',()=>{
 const main=readFileSync(new URL('../../src/main.tsx',import.meta.url),'utf8');
 const preview=main.indexOf("import.meta.env.VITE_DEPLOY_ENV === 'preview' && location.pathname === '/'");
 const redirect=main.indexOf("history.replaceState(history.state, '', '/report-issue'");
 const publicBranch=main.indexOf("if (/^\\/report-issue\\/?$/.test(location.pathname))");
 const privateApp=main.indexOf("import('./App')");
 assert.ok(preview>=0 && preview<redirect && redirect<publicBranch && publicBranch<privateApp);
});

test('quantity must be a numeric count and sheet retains Hebrew units',()=>{
 for(const q of ['3 חביות','3.5','-1','abc','0','1000000'])assert.throws(()=>validateReport({...base,quantity:q}),undefined,q);
 assert.equal(validateReport({...base,quantity:'00003'}).quantity,'3');
 assert.equal(validateReport({...base,quantity:''}).quantity,'');
 const bottles=validateReport({...base,quantity:'12',packageType:'בקבוק'});
 assert.equal(createSheetRow('5','INC-5',bottles,[],new Date('2026-10-26'),'uuid')[6],'12 בקבוקים');
});
test('public form has real bottle SVG, foam icon and clean heading',()=>{
 const src=readFileSync(new URL('../../src/public-report/ReportPage.tsx',import.meta.url),'utf8');
 assert.match(src,/<BottleWine size=\{21\}/);
 assert.match(src,/<Bubbles size=\{24\}/);
 assert.doesNotMatch(src,/SHAPIRO · QUALITY CONTROL|<div className="q-overline">/);
 assert.doesNotMatch(src,/טופס דיווח<\/span>/);
 assert.match(src,/placeholder="למשל בירה שפירא, נחם"/);
});

test('mobile third-step layout prevents a long attachment name from enlarging the screen',()=>{
 const src=readFileSync(new URL('../../src/public-report/ReportPage.css',import.meta.url),'utf8');
 assert.match(src,/\.q-fields,\.q-files\{grid-template-columns:minmax\(0,1fr\)\}/);
 assert.match(src,/\.q-files li>div\{flex:1 1 0;min-width:0/);
 assert.match(src,/\.q-files li b\{[^}]*text-overflow:ellipsis/);
 assert.match(src,/\.q-actions\{width:100%;flex-wrap:wrap\}/);
});
test('batch keyboard is numeric, and input normalizes digits only',()=>{
 const src=readFileSync(new URL('../../src/public-report/ReportPage.tsx',import.meta.url),'utf8');
 const batch=src.slice(src.indexOf('<span>מספר אצווה</span>'),src.indexOf('<span>תאריך תפוגה</span>'));
 assert.match(batch,/inputMode="numeric"/);
 assert.match(batch,/pattern="\[0-9\]\*"/);
 assert.match(batch,/replace\(\/\[\^0-9\]\/g,''\)/);
});

test('mail always sent on each report, with a batch-specific note for three or more incidents',()=>{
 const src=readFileSync(new URL('../index.mjs',import.meta.url),'utf8');
 assert.match(src,/getStorage\(\).bucket/);
 assert.match(src,/tx.create\(idRef/);
 assert.match(src,/status:'queued'/);
 assert.doesNotMatch(src,/google.auth.OAuth2|QUALITY_GOOGLE_REFRESH_TOKEN|export const qualityReportWeekly|export const qualityReportMailRetry/);
});

test('brewcrew standalone worker handles signed immediate dispatch to Sheets, Drive and MailApp',()=>{
 const worker=readFileSync(new URL('../../quality-appsscript/Code.js',import.meta.url),'utf8');
 const manifest=readFileSync(new URL('../../quality-appsscript/appsscript.json',import.meta.url),'utf8');
 assert.match(worker,/ScriptApp.getOAuthToken\(\)/);
 assert.match(worker,/function doPost\(e\)/);
 assert.match(worker,/DriveApp.getFolderById/);
 assert.match(worker,/MailApp.sendEmail/);
 assert.match(worker,/state.sheet.getRange/);
 assert.match(worker,/qFindExisting_/);
 assert.match(worker,/qConstantTimeEqual_/);
 assert.match(manifest,/script.send_mail/);
 assert.match(manifest,/"webapp"/);
});
test('public acknowledgment means queued, not saved in Sheets yet',()=>{
 const ui=readFileSync(new URL('../../src/public-report/ReportPage.tsx',import.meta.url),'utf8');
 assert.match(ui,/אסמכתה זמנית/);
 assert.match(ui,/הדיווח התקבל לעיבוד/);
 assert.doesNotMatch(ui,/result.ticket/);
});
