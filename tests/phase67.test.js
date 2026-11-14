'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const samples=require('../lib/reading-samples');
const delay=ms=>new Promise(done=>setTimeout(done,ms));
function dbMemory(){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;CREATE TABLE books(id INTEGER PRIMARY KEY,title TEXT);CREATE TABLE users(id INTEGER PRIMARY KEY);INSERT INTO books VALUES(1,\'نمونه کتاب\');INSERT INTO users VALUES(1);');samples.migrate(db);return db;}
const textSample='این متن فقط یک نمونه آزمایشی نوشته‌شده برای آزمون سامانه است. این جمله هیچ بخشی از متن واقعی کتاب نیست و فقط شرایط نمایش مجوز را بررسی می‌کند.';
const initial={book_id:'1',revision:'0',status:'published',body:textSample,rights_holder:'مالک حقوق نمونه آزمایشی',rights_evidence:'قرارداد اختصاصی نمونه آزمایشی شماره ۱۲۳۴۵۶',license_confirm:'1',expires_on:''};
test('6.7: no unauthorized sample, revision lock, revoke and history',()=>{
 const db=dbMemory();try{
  assert.equal(samples.publicSample(db,1),null);
  assert.throws(()=>samples.save(db,{...initial,license_confirm:'0'},1),/اجازه|مدرک|انتشار/);
  assert.equal(samples.save(db,initial,1),1);
  assert.equal(samples.publicSample(db,1).body,textSample);
  assert.throws(()=>samples.save(db,initial,1),/تغییر/);
  assert.equal(samples.save(db,{...initial,revision:'1',status:'withdrawn',license_confirm:'0'},1),2);
  assert.equal(samples.publicSample(db,1),null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_reading_sample_history WHERE book_id=1').get().n,2);
  assert.equal(samples.save(db,{...initial,revision:'2',status:'published'},1),3);
  db.prepare('UPDATE book_reading_samples SET body=? WHERE book_id=1').run(textSample+' دستکاری');
  assert.equal(samples.publicSample(db,1),null);
 }finally{db.close();}
});
test('6.7: expired permission blocks public sample, never changes paid PDF rights',()=>{
 const db=dbMemory();try{
  samples.save(db,{...initial,expires_on:'2020-01-01',status:'draft',license_confirm:'0'},1);
  assert.throws(()=>samples.save(db,{...initial,revision:'1',expires_on:'2020-01-01'},1),/منقضی/);
  samples.save(db,{...initial,revision:'1',expires_on:'2099-01-01'},1);
  assert.ok(samples.publicSample(db,1,'2098-12-31'));
  assert.equal(samples.publicSample(db,1,'2100-01-01'),null);
 }finally{db.close();}
});
async function boot(t,publicMode=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq67-'));
 const probe=net.createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
 const base='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:publicMode?base:''},stdio:['ignore','pipe','pipe']});let errors='';proc.stderr.on('data',x=>errors+=x);
 t.after(async()=>{if(proc.exitCode===null){proc.kill();await Promise.race([new Promise(ok=>proc.once('exit',ok)),delay(1400)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<130;i++){try{if((await fetch(base+'/health')).ok)return{dir,base};}catch{}await delay(65);}throw Error(errors||'server failed');
}
test('6.7: real public reader hides unlicensed sample, prevents PDF disclosure, noindex',async t=>{
 const {base,dir}=await boot(t,true);
 let res=await fetch(base+'/book/book-001/read');assert.equal(res.status,200);
 let html=await res.text();assert.match(html,/فضای مطالعه|معرفی کتاب/);assert.match(html,/نمونه‌ای از متن اصلی کتاب با مجوز قابل‌انتشار فعلاً ثبت نشده/);
 assert.match(html,/name="robots" content="noindex,nofollow"/);
 assert.match(res.headers.get('x-robots-tag'),/noindex/);
 assert.match(html,/data-reading-font="larger"/);assert.doesNotMatch(html,/فروش پولی فعال است/);
 assert.equal((await fetch(base+'/book/missing-book/read')).status,404);
 assert.equal((await fetch(base+'/pdf-delivery/'+'A'.repeat(43))).status,404);
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));t.after(()=>db.close());
 assert.equal(db.prepare('SELECT COUNT(*) n FROM book_reading_samples').get().n,0);
 assert.equal((await(await fetch(base+'/health')).json()).payment_enabled,false);
});
async function owner(base){
 const login=p=>fetch(base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password:p}),redirect:'manual'});
 let r=await login('ad123456789');const cookie=r.headers.get('set-cookie').split(';')[0];
 r=await fetch(base+'/panel/account',{headers:{cookie}});const csrf=(await r.text()).match(/name="csrf" value="([^"]+)"/)[1];
 r=await fetch(base+'/panel/account',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,username:'admin',old_password:'ad123456789',new_password:'VARAQ-67-Long-Secure-Key!',confirm_password:'VARAQ-67-Long-Secure-Key!'}),redirect:'manual'});assert.equal(r.status,303);
 r=await login('VARAQ-67-Long-Secure-Key!');return r.headers.get('set-cookie').split(';')[0];
}
test('6.7: admin sample form, CSRF and publish/revoke over HTTP',async t=>{
 const {base}=await boot(t);
 assert.notEqual((await fetch(base+'/panel/reading-samples',{redirect:'manual'})).status,200);
 const cookie=await owner(base),h={cookie};
 let r=await fetch(base+'/panel/reading-samples?book=1',{headers:h});assert.equal(r.status,200);
 const csrf=(await r.text()).match(/name="csrf" value="([^"]+)"/)[1];
 const send=fields=>fetch(base+'/panel/reading-samples',{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
 r=await send({...initial,csrf:'wrong'});assert.equal(r.status,403);
 r=await send({...initial,csrf});assert.equal(r.status,303);
 r=await fetch(base+'/book/book-001/read');let html=await r.text();assert.match(html,/مالک حقوق نمونه آزمایشی/);assert.match(html,/هیچ بخشی از متن واقعی کتاب نیست/);
 r=await send({...initial,revision:'1',status:'withdrawn',license_confirm:'0',csrf});assert.equal(r.status,303);
 r=await fetch(base+'/book/book-001/read');html=await r.text();assert.doesNotMatch(html,/هیچ بخشی از متن واقعی کتاب نیست/);
 r=await send({...initial,revision:'1',status:'published',csrf});assert.equal(r.status,409);
});
