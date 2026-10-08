// Regression tests for camera PoC geometry. Run: node --test tests/camera-poc.test.cjs
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function loadFunction(file,name,globals={}) {
 const src=fs.readFileSync(file,'utf8');const start=src.indexOf('function '+name+'(');
 assert.ok(start>=0,'missing '+name);let p=src.indexOf('{',start),depth=0,end=-1;
 for(let i=p;i<src.length;i++){if(src[i]==='{')depth++;if(src[i]==='}'&&--depth===0){end=i+1;break}}
 assert.ok(end>p,'unclosed '+name);const ctx=vm.createContext(globals);
 return vm.runInContext('('+src.slice(start,end)+')',ctx);
}
const panel='public/temperature-panel-poc.html',gauge='public/gauge-poc.html';
const c={width:1200,height:2000};let messages=[];
const assign=loadFunction(panel,'assign',{c,log:x=>messages.push(x)});
function controller(x,y){return{x,y,w:42,h:26}}
function grid(x,rows){return rows.flatMap((n,i)=>Array.from({length:n},(_,j)=>controller(x+j*105,240+i*240)))}
const physical=[...grid(120,[3,3,3,2]),...grid(780,[3,3,2])];
test('19 physical controllers map exactly to tanks 2–19 and exclude CLT 1',()=>{
 const result=assign(physical);assert.ok(result);assert.equal(result.length,18);
 assert.deepEqual([...result.map(v=>v.n)].sort((a,b)=>a-b),Array.from({length:18},(_,i)=>i+2));
 assert.equal(result.find(v=>v.n===2).x,885); // skip first right cabinet controller (#1)
 assert.equal(result.find(v=>v.n===9).x,120);
});
test('missing controller never shifts tank labels',()=>{
 for(const i of [0,2,5,10,11,14,18])assert.equal(assign(physical.filter((_,j)=>j!==i)),null);
});
test('extra red component is rejected rather than assigned to a tank',()=>{
 assert.equal(assign([...physical,controller(600,1300)]),null);
});
test('pressure angle maps zero, midpoint and maximum without tenth-bar rounding',()=>{
 const f=loadFunction(gauge,'pressureFromAngle');
 assert.equal(f(135,4),0);assert.equal(f(270,4),2);assert.equal(f(405,4),4);
 assert.equal(Number(f(225.45,4).toFixed(2)),1.34);
});
test('non-gauge blank scene does not pass dial evidence',()=>{
 const f=loadFunction(gauge,'dialEvidence');const W=900,H=900;
 assert.equal(f(new Uint8Array(W*H).fill(210),W,H).ok,false);
});

test('dense real-looking dial tick pattern is not rejected merely for 36 dark sectors',()=>{
 const f=loadFunction(gauge,'dialEvidence'),W=900,H=900,d=new Uint8Array(W*H).fill(255);
 for(let deg=0;deg<360;deg+=10){
  const a=deg*Math.PI/180,gray=(deg/10)%2===0?55:150;
  for(let rr=.28;rr<=.40;rr+=.003){
   const x=Math.round(W/2+Math.cos(a)*W*rr),y=Math.round(H/2+Math.sin(a)*H*rr);
   for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)d[(y+dy)*W+x+dx]=gray;
  }
 }
 const result=f(d,W,H);
 assert.equal(result.hits,36);
 assert.ok(result.variation>.065);
 assert.equal(result.ok,true);
});

// Guard against a regression where a frozen camera frame bypasses the dial gate.
test('frozen camera capture checks dial evidence before displaying a pressure',()=>{
 const source=fs.readFileSync(gauge,'utf8');
 const capture=source.slice(source.indexOf('async function captureBurst()'),source.indexOf('async function analyzeImage('));
 assert.match(capture,/dialEvidence\(gd,c\.width,c\.height\)/);
 assert.match(capture,/if\(!dial\.ok\)/);
 assert.ok(capture.indexOf('if(!dial.ok)')<capture.indexOf('res.textContent=p.toFixed(2)'));
});
test('offline image cannot turn the guide green before a successful read',()=>{
 const source=fs.readFileSync(gauge,'utf8');
 const analyze=source.slice(source.indexOf('async function analyzeImage('));
 assert.doesNotMatch(analyze,/guide\.classList\.toggle\('ok',quality/);
 assert.ok(analyze.indexOf("guide.classList.add('ok')")>analyze.indexOf('if(p==null||!quality||needle.ambiguous)'));
});
