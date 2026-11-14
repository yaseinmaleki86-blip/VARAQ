'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const compare=require('../lib/book-comparison');
const catalogue=require('../data/books.json');
const delay=ms=>new Promise(done=>setTimeout(done,ms));

test('6.6: validation, duplicate prevention, exact slug and relation without invented ranking',()=>{
 let r=compare.selectBooks(['book-001','book-002'],catalogue);
 assert.equal(r.error,'');assert.deepEqual(r.books.map(b=>b.slug),['book-001','book-002']);
 assert.match(compare.selectBooks(['book-001','book-001'],catalogue).error,/فقط یک‌بار/);
 assert.match(compare.selectBooks(['book-001','book-002','book-003','book-004'],catalogue).error,/حداکثر/);
 assert.match(compare.selectBooks(['<script>'],catalogue).error,/معتبر/);
 assert.match(compare.selectBooks(['book-9999'],catalogue).error,/یافت نشد/);
 assert.match(compare.pairLink(catalogue[0],catalogue[1]),/^\/books\/compare\?book=book-001&book=book-002$/);
 assert.match(compare.relation(catalogue[0],catalogue[1],()=>[]),/دسته‌بندی|نویسنده|موضوعات/);
});
async function serve(t,publicMode=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq66-'));
 const socket=net.createServer();await new Promise(ok=>socket.listen(0,'127.0.0.1',ok));const port=socket.address().port;await new Promise(ok=>socket.close(ok));
 const base='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:publicMode?base:''},stdio:['ignore','pipe','pipe']});
 let error='';proc.stderr.on('data',c=>error+=c);
 t.after(async()=>{if(proc.exitCode===null){proc.kill();await Promise.race([new Promise(ok=>proc.once('exit',ok)),delay(1300)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<120;i++){try{if((await fetch(base+'/health')).ok)return {base,dir};}catch{}await delay(70);}
 throw Error(error||'server did not start');
}
test('6.6: comparison route, disabled payments, links and private SEO; real HTTP',async t=>{
 const {base,dir}=await serve(t);
 const health=await(await fetch(base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
 const r=await fetch(base+'/books/compare?book=book-001&book=book-002');assert.equal(r.status,200);
 const html=await r.text();assert.match(html,/نتیجه مقایسه/);assert.match(html,/راهنمای انتخاب/);assert.match(html,/معرفی اولیه/);
 assert.match(html,/name="book"/);assert.match(html,/کتاب اول/);
 assert.match(html,/مقایسه مشخصات/);
 assert.doesNotMatch(html,/بهترین کتاب بر اساس فروش|امتیاز قطعی/);
 const single=await(await fetch(base+'/book/book-001')).text();assert.match(single,/مقایسه با کتاب دیگر/);assert.match(single,/مقایسه با این کتاب/);
 const invalid=await fetch(base+'/books/compare?book=book-001&book=book-001');assert.equal(invalid.status,400);
 const tooMany=await fetch(base+'/books/compare?book=book-001&book=book-002&book=book-003&book=book-004');assert.equal(tooMany.status,400);
 const injection=await fetch(base+'/books/compare?book=%3Cscript%3E');assert.equal(injection.status,400);
 assert.ok(!(await injection.text()).includes('<script>alert('));
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'));assert.equal(db.prepare('SELECT COUNT(*) n FROM books').get().n,1000);db.close();
});
test('6.6: public preview comparison is noindex and remains read-only',async t=>{
 const {base}=await serve(t,true);
 const res=await fetch(base+'/books/compare?book=book-001&book=book-002');assert.equal(res.status,200);
 const html=await res.text();assert.match(html,/name="robots" content="noindex,nofollow"/);
 assert.match(html,/پرداخت غیرفعال/);
 const r=await fetch(base+'/demo-order/preview',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:''});assert.equal(r.status,403);
});
