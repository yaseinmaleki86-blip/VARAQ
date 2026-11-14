'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const desk=require('../lib/finishing-desk');
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function boot(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq55-'));
 const probe=net.createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
 const base='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:'',VARAQ_CURATED_SEED:'1'},stdio:['ignore','pipe','pipe']});
 let errors='';proc.stderr.on('data',b=>errors+=b.toString());
 t.after(async()=>{if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(ok=>proc.once('exit',ok)),sleep(1500)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<150;i++){try{if((await fetch(base+'/health')).ok)return {base,dir};}catch{}await sleep(50);}throw Error('server could not start: '+errors);
}
async function owner(base){
 const login=password=>fetch(base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password}),redirect:'manual'});
 let response=await login('ad123456789'),cookie=response.headers.get('set-cookie').split(';')[0];
 response=await fetch(base+'/panel/account',{headers:{cookie}});let csrf=(await response.text()).match(/name="csrf" value="([^"]+)"/)[1];
 response=await fetch(base+'/panel/account',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,username:'admin',old_password:'ad123456789',new_password:'VarAQ-Secure-Pass-55-ready!',confirm_password:'VarAQ-Secure-Pass-55-ready!'}),redirect:'manual'});assert.equal(response.status,303);
 response=await login('VarAQ-Secure-Pass-55-ready!');return response.headers.get('set-cookie').split(';')[0];
}
test('5.5 finishing desk uses actual catalog rows, filters, CSV and does not mutate database',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 const rows=desk.scan(db,s.dir);assert.equal(rows.length,1000);
 const missing=desk.select(rows,{mode:'cover'});assert.equal(missing.total,1000);
 const author=desk.select(rows,{mode:'author'});assert.ok(author.total>0&&author.total<200);
 const pages=desk.select(rows,{mode:'all',page:999});assert.equal(pages.page,pages.totalPages);
 const orig=db.prepare('SELECT count(*) n FROM books').get().n;
 const c=desk.csv(rows);assert.match(c,/\uFEFF/);assert.match(c,/local_cover/);
 assert.equal(db.prepare('SELECT count(*) n FROM books').get().n,orig);
});
test('5.5 owner workbench and filtered export reject unauthorized access and escape injections',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 let r=await fetch(s.base+'/panel/finishing-desk',{redirect:'manual'});assert.equal(r.status,303);
 const cookie=await owner(s.base);
 db.prepare('UPDATE books SET title=? WHERE id=1').run('=2+4 <img src=x onerror=alert(1)>');
 r=await fetch(s.base+'/panel/finishing-desk?status=author&page=1',{headers:{cookie}});assert.equal(r.status,200);
 let html=await r.text();assert.match(html,/میز کار تکمیل کتابخانه/);assert.match(html,/CSV همین فیلتر/);
 r=await fetch(s.base+'/panel/finishing-desk?status=all&q=%3Cimg',{headers:{cookie}});assert.equal(r.status,200);html=await r.text();
 assert.doesNotMatch(html,/<img src=x onerror=alert/);assert.match(html,/&lt;img/);
 r=await fetch(s.base+'/panel/finishing-desk.csv?status=all&q=%3Cimg',{headers:{cookie}});assert.equal(r.status,200);
 const csv=await r.text();assert.match(csv,/'=2\+4/);assert.match(r.headers.get('content-type'),/text\/csv/);
 const store=db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get(),hash=db.prepare("SELECT password_hash FROM users WHERE role='owner'").get().password_hash;
 db.prepare("INSERT INTO users(username,password_hash,role,store_id,enabled,must_change_password,staff_permission) VALUES(?,?,'seller',?,1,0,'manager')").run('seller55',hash,store.id);
 r=await fetch(s.base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'seller55',password:'VarAQ-Secure-Pass-55-ready!'}),redirect:'manual'});
 const seller=r.headers.get('set-cookie').split(';')[0];
 for(const dest of ['/panel/finishing-desk','/panel/finishing-desk.csv']){r=await fetch(s.base+dest,{headers:{cookie:seller}});assert.equal(r.status,403);}
});
test('5.5 edition prefill only for verified pending ISBN, with local-only preview controls',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 const cookie=await owner(s.base),isbn='9780131103627';
 db.prepare("INSERT INTO editions(book_id,label,publisher,isbn,verified) VALUES(1,'چاپ آزمون ۵.۵','ناشر مجاز',?,1)").run(isbn);
 let r=await fetch(s.base+'/panel/cover-web-upload?isbn='+isbn,{headers:{cookie}});assert.equal(r.status,200);
 let html=await r.text();assert.match(html,/چاپ انتخاب‌شده از صف پیگیری/);assert.match(html,/value="9780131103627"/);
 assert.match(html,/data-cover-preview="1"/);assert.match(html,/data-cover-slot="1"/);
 r=await fetch(s.base+'/panel/cover-web-upload?isbn='+encodeURIComponent('<script>'),{headers:{cookie}});html=await r.text();
 assert.doesNotMatch(html,/value="<script>/);assert.doesNotMatch(html,/چاپ انتخاب‌شده از صف پیگیری/);
 r=await fetch(s.base+'/panel/cover-intake',{headers:{cookie}});assert.match(await r.text(),/ارسال جلد/);
 const health=await(await fetch(s.base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
});
