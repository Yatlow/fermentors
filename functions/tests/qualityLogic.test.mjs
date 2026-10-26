import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReport,relatedEvent,distinctSkuEvents,rowsToReports,createSheetRow,formatIsraeliDate,normalize} from '../qualityLogic.mjs';
const base = {customer:'החור השחור',beer:'לאגר',issueType:'הקצפת יתר',packageType:'חבית',reporter:'רון',description:'מקציף בפולסים',quantity:'3 חביות',batch:'1532',expiry:'2026-12-25'};
test('validates and normalizes SKU while keeping quantity free text',()=>{
  const r=validateReport(base); assert.equal(r.sku,'לאגר / חבית'); assert.equal(r.quantity,'3 חביות');
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
  const reports=['INC-1','INC-1','INC-2'].map(eventId=>({eventId,date:new Date('2026-10-20'),beer:'לאגר',packageType:'חבית',sku:'לאגר / חבית'}));
  assert.equal(distinctSkuEvents(reports,validateReport(base),now).size,2);
});
test('reads original twenty columns and appends metadata without moving old columns',()=>{
 const raw=new Array(30).fill('');raw[0]='3';raw[2]='החור השחור';raw[3]='לאגר';raw[4]='1532';raw[6]='3 חביות';raw[7]='25/10/26';raw[9]='3 חביות מקציפות';
 const existing=rowsToReports([raw]);assert.equal(existing[0].type,'הקצפת יתר');assert.equal(existing[0].packageType,'חבית');
 const row=createSheetRow('4','INC-3',validateReport(base),['https://drive.google.com/file/d/example/view'],new Date('2026-10-26T08:00:00Z'),'uuid');
 assert.equal(row[20],'INC-3');assert.equal(row[25].includes('drive.google.com'),true);assert.equal(row.length,30);
 assert.equal(formatIsraeliDate(new Date('2026-10-26T08:00:00Z')),'26/10/2026');
 assert.equal(normalize('חבית  /  לאגר'),'חבית לאגר');
});
