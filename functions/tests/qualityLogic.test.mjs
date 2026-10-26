import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {validateReport,relatedEvent,distinctSkuEvents,rowsToReports,createSheetRow,formatIsraeliDate,normalize,mergeSkuHistory,parseSheetDate} from '../qualityLogic.mjs';
const base = {customer:'החור השחור',beer:'לאגר',issueType:'הקצפת יתר',packageType:'חבית',reporter:'רון',description:'מקציף בפולסים',quantity:'3 חביות',batch:'1532',expiry:'2026-12-25'};
test('validates and normalizes SKU while keeping quantity free text',()=>{
  const r=validateReport(base); assert.equal(r.sku,'7009942'); assert.equal(r.quantity,'3 חביות');
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
test('same event reported multiple times is one incident for threshold',()=>{
  const now=new Date('2026-10-26');
  const reports=['INC-1','INC-1','INC-2'].map(eventId=>({eventId,date:new Date('2026-10-20'),beer:'לאגר',packageType:'חבית',sku:'7009942'}));
  assert.equal(distinctSkuEvents(reports,validateReport(base),now).size,2);
});
test('reads original twenty columns and appends metadata without moving old columns',()=>{
 const raw=new Array(30).fill('');raw[0]='3';raw[2]='החור השחור';raw[3]='לאגר';raw[4]='1532';raw[6]='3 חביות';raw[7]='25/10/26';raw[9]='3 חביות מקציפות';
 const existing=rowsToReports([raw]);assert.equal(existing[0].type,'הקצפת יתר');assert.equal(existing[0].packageType,'חבית');
 assert.equal(existing[0].sku,'7009942');
 const row=createSheetRow('4','INC-3',validateReport(base),['https://drive.google.com/file/d/example/view'],new Date('2026-10-26T08:00:00Z'),'uuid');
 assert.equal(row[20],'INC-3');assert.equal(row[25].includes('drive.google.com'),true);assert.equal(row.length,30);
 assert.equal(formatIsraeliDate(new Date('2026-10-26T08:00:00Z')),'26/10/2026');
 assert.equal(normalize('חבית  /  לאגר'),'חבית לאגר');
});

test('unknown special beers and cans never escalate as a guessed SKU',()=>{
 assert.equal(validateReport({...base,beer:'מיוחדת 2026'}).sku,'');
 assert.equal(validateReport({...base,packageType:'פחית'}).sku,'');
});
test('distinct event IDs count once even with multiple reporters',()=>{
 const now=new Date('2026-10-26');
 const reports=[1,1,2,3].map(n=>({eventId:'INC-'+n,date:new Date('2026-10-24'),sku:'7009942'}));
 assert.equal(distinctSkuEvents(reports,validateReport(base),now).size,3);
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
 const code=source.slice(source.indexOf('export const qualityReport=onRequest'),source.indexOf('export const qualityReportWeekly='));
 const antiBot=code.indexOf('await checkTurnstile(fields.turnstileToken,req.ip)');
 const limit=code.indexOf('await chargeLimit(req.ip)');
 const catalog=code.indexOf("database.doc('productCatalog/'+key).get()");
 const sheet=code.indexOf('const rows=await sheetRows(sheets)');
 assert.ok(antiBot>=0 && antiBot<limit && limit<catalog && catalog<sheet);
});
