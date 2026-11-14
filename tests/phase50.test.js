'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const audit=require('../lib/release-audit');
const ROOT=path.resolve(__dirname,'..');
async function freePort(){const s=net.createServer();await new Promise(ok=>s.listen(0,'127.0.0.1',ok));const n=s.address().port;await new Promise(ok=>s.close(ok));return n;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function start(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq50-')),port=await freePort(),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',d=>err+=d);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let k=0;k<100;k++){try{if((await fetch(base+'/health')).ok)return {base,dir};}catch{}await delay(80);}throw Error('Startup failed: '+err);
}
test('5.0 read-only audit reports exact catalogue gaps and never enables sales',async t=>{
 const s=await start(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'),{readOnly:true});t.after(()=>db.close());
 const env={...process.env,PUBLIC_URL:'https://books.example',HOST:'127.0.0.1',VARAQ_LEGAL_REVIEWED:'1',VARAQ_MEDIA_RIGHTS_REVIEWED:'1',VARAQ_BROWSER_QA_APPROVED:'1',VARAQ_PUBLIC_INDEX:'1'};
 const result=audit.assess({db,dataDir:s.dir,env});
 assert.equal(result.version,'8.6.0');assert.equal(result.metrics.books,1000);
 assert.ok(result.metrics.missingCover>0);assert.ok(result.metrics.missingAuthor>0);
 assert.equal(result.readyForInformationPreview,false);assert.equal(result.readyForPublicSales,false);
 assert.equal(result.paymentEnabled,false);
 assert.equal(result.checks.find(x=>x.id==='gateway_end_to_end').ok,false);
 assert.equal(result.checks.find(x=>x.id==='verified_backup').ok,false);
 const csv=audit.toCsv(result);assert.match(csv,/gateway_end_to_end/);assert.match(csv,/catalog_complete/);
 const fake=audit.toCsv({checks:[{scope:'preview',id:'title',ok:false,detail:'=HYPERLINK("http://evil")'}]});assert.match(fake,/"'=HYPERLINK/);
});
test('5.0 CLI JSON and strict-sales are blocked; owner-only panel report and CSV',async t=>{
 const s=await start(t);
 const env={...process.env,DATA_DIR:s.dir,PUBLIC_URL:'https://books.example'};
 const cli=spawnSync(process.execPath,['preflight.js','--json','--strict-sales'],{cwd:ROOT,env,encoding:'utf8'});
 assert.equal(cli.status,1);const result=JSON.parse(cli.stdout);assert.equal(result.readyForPublicSales,false);
 const get=(p,c='')=>fetch(s.base+p,{headers:{cookie:c},redirect:'manual'});
 const post=(p,data,c='')=>fetch(s.base+p,{method:'POST',headers:{cookie:c,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data),redirect:'manual'});
 let r=await get('/panel/release-readiness');assert.equal(r.status,303);
 r=await get('/panel/release-readiness.csv');assert.equal(r.status,303);
 r=await post('/login',{username:'admin',password:'ad123456789'});let cookie=r.headers.get('set-cookie').split(';')[0];
 r=await get('/panel/account',cookie);let csrf=(await r.text()).match(/name="csrf" value="([^"]+)"/)[1];
 await post('/panel/account',{csrf,username:'admin',old_password:'ad123456789',new_password:'SecureNewOwnerPassword123',confirm_password:'SecureNewOwnerPassword123'},cookie);
 r=await post('/login',{username:'admin',password:'SecureNewOwnerPassword123'});cookie=r.headers.get('set-cookie').split(';')[0];
 r=await get('/panel/release-readiness',cookie);assert.equal(r.status,200);
 const html=await r.text();assert.match(html,/NO-GO/);assert.match(html,/آمادگی انتشار/);assert.match(html,/gateway_end_to_end/);
 r=await get('/panel/release-readiness.csv',cookie);assert.equal(r.status,200);
 assert.match(r.headers.get('cache-control'),/no-store/);assert.match(await r.text(),/verified_backup/);
 const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));
 try{
  const owner=db.prepare("SELECT password_hash FROM users WHERE role='owner'").get();
  const store=db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get();
  db.prepare("INSERT INTO users(username,password_hash,role,store_id,enabled,must_change_password,staff_permission) VALUES(?,?,'seller',?,1,0,'manager')").run('store_v50',owner.password_hash,store.id);
 }finally{db.close();}
 r=await post('/login',{username:'store_v50',password:'SecureNewOwnerPassword123'});
 const sellerCookie=r.headers.get('set-cookie').split(';')[0];
 r=await get('/panel/release-readiness',sellerCookie);assert.equal(r.status,403);
 r=await get('/panel/release-readiness.csv',sellerCookie);assert.equal(r.status,403);
 r=await get('/health');assert.deepEqual(await r.json(),{ok:true,version:'8.6.0',payment_enabled:false,orders_mode:'demo_only'});
 r=await post('/payments/verify',{success:'1'});assert.equal(r.status,404);
});
