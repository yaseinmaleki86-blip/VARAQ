'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const wb=require('../lib/content-workbook'),contentBatch=require('../lib/content-batch');
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function boot(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq53-'));
 const probe=net.createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
 const base='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:'',VARAQ_CURATED_SEED:'1'},stdio:['ignore','pipe','pipe']});
 let errors='';proc.stderr.on('data',b=>errors+=b.toString());
 t.after(async()=>{if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(ok=>proc.once('exit',ok)),sleep(1600)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<150;i++){try{if((await fetch(base+'/health')).ok)return {base,dir};}catch{}await sleep(50);}
 throw Error('server could not start: '+errors);
}
async function loginOwner(base){
 const login=password=>fetch(base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password}),redirect:'manual'});
 let response=await login('ad123456789');let cookie=response.headers.get('set-cookie').split(';')[0];
 response=await fetch(base+'/panel/account',{headers:{cookie}});const csrf=(await response.text()).match(/name="csrf" value="([^"]+)"/)[1];
 response=await fetch(base+'/panel/account',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,username:'admin',old_password:'ad123456789',new_password:'VarAQ-Secure-Pass-53-ready!',confirm_password:'VarAQ-Secure-Pass-53-ready!'}),redirect:'manual'});
 assert.equal(response.status,303);response=await login('VarAQ-Secure-Pass-53-ready!');return response.headers.get('set-cookie').split(';')[0];
}
test('5.3 generated worksheet filters missing facts, paginates by 50, and never supplies made-up metadata or permission',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 const all=wb.select(db,{missing:'all',batch:1});assert.equal(all.stats.books,1000);assert.ok(all.stats.incomplete>0);assert.ok(all.pages>=2);
 assert.equal(all.items.length,50);
 const second=wb.select(db,{missing:'all',batch:2});assert.ok(second.items.length<=50);assert.ok(!second.items.some(x=>all.items.some(y=>x.id===y.id)));
 const author=wb.select(db,{missing:'author'});assert.ok(author.items.every(x=>x.needs.includes('author')));
 const filtered=wb.select(db,{missing:'author',q:String(author.items[0].id)});assert.ok(filtered.items.some(x=>x.id===author.items[0].id));
 const csv=wb.csv(all.items);assert.match(csv,/"book_id","author","publisher","description","source_url"/);assert.equal(csv.trim().split('\n').length,51);
 assert.ok(csv.split('\n').slice(1).every(line=>!line||!line.includes('https://')));
 assert.match(wb.guide(all.items),/edition_reference_for_research_only/);
 const tail=wb.select(db,{missing:'all',batch:9999});assert.equal(tail.batch,tail.pages);assert.ok(tail.items.length<=50);
 const sample=author.items[0];const row={book_id:sample.id,author:'نویسنده مستند آزمون داخلی',publisher:'',description:'',source_url:'https://example.org/edition/sample'};
 const importCsv='book_id,author,publisher,description,source_url\n'+[row.book_id,row.author,'','',row.source_url].join(',')+'\n';
 const parsed=contentBatch.parseCsv(importCsv);assert.equal(contentBatch.inspect(db,parsed)[0].changes.length,1);
 assert.equal(contentBatch.apply(db,parsed,{id:1,role:'owner'}).fields,1);
 assert.equal(db.prepare('SELECT author FROM books WHERE id=?').get(row.book_id).author,row.author);
 assert.throws(()=>contentBatch.apply(db,parsed,{id:1,role:'owner'}),/بازنویسی/);
 assert.equal(db.prepare('SELECT count(*) n FROM book_metadata_evidence WHERE book_id=? AND field=?').get(row.book_id,'author').n,1);
});
test('5.3 intake worksheet owner-only HTTP routes, escape values, file import UI and disabled paid checkout',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 let res=await fetch(s.base+'/panel/content-workbook',{redirect:'manual'});assert.equal(res.status,303);
 const cookie=await loginOwner(s.base);
 res=await fetch(s.base+'/panel/content-workbook?missing=author&batch=1',{headers:{cookie}});assert.equal(res.status,200);
 const html=await res.text();assert.match(html,/کاربرگ تکمیل اطلاعات/);assert.match(html,/CSV قابل ورود/);assert.match(html,/در انتظار جلد مجاز/);
 const qs='missing=author&batch=1';
 res=await fetch(s.base+'/panel/content-workbook.csv?'+qs,{headers:{cookie}});assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/text\/csv/);assert.match(res.headers.get('cache-control'),/no-store/);
 const plain=await res.text();assert.match(plain,/book_id/);
 res=await fetch(s.base+'/panel/content-workbook-guide.csv?'+qs,{headers:{cookie}});assert.equal(res.status,200);assert.match(await res.text(),/verified_isbn/);
 res=await fetch(s.base+'/panel/content-batch',{headers:{cookie}});assert.equal(res.status,200);assert.match(await res.text(),/content-workbook-upload/);
 res=await fetch(s.base+'/health');const health=await res.json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
 const hash=db.prepare("SELECT password_hash FROM users WHERE role='owner'").get().password_hash,store=db.prepare('SELECT id FROM stores LIMIT 1').get();
 db.prepare("INSERT INTO users(username,password_hash,role,store_id,enabled,must_change_password,staff_permission) VALUES(?,?,'seller',?,1,0,'manager')").run('seller53',hash,store.id);
 res=await fetch(s.base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'seller53',password:'VarAQ-Secure-Pass-53-ready!'}),redirect:'manual'});
 const seller=res.headers.get('set-cookie').split(';')[0];
 for(const route of ['/panel/content-workbook','/panel/content-workbook.csv','/panel/content-workbook-guide.csv']){
  res=await fetch(s.base+route,{headers:{cookie:seller},redirect:'manual'});assert.equal(res.status,403,route);
 }
});
