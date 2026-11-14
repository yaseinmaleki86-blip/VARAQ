'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const audit=require('../lib/catalog-consistency');
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function boot(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq56-'));
 const probe=net.createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
 const base='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:'',VARAQ_CURATED_SEED:'1'},stdio:['ignore','pipe','pipe']});
 let errors='';proc.stderr.on('data',b=>errors+=b.toString());
 t.after(async()=>{if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(ok=>proc.once('exit',ok)),sleep(1500)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<160;i++){try{if((await fetch(base+'/health')).ok)return {base,dir};}catch{}await sleep(50);}
 throw Error('5.6 server could not start: '+errors);
}
async function owner(base){
 const login=password=>fetch(base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password}),redirect:'manual'});
 let r=await login('ad123456789');assert.equal(r.status,303);
 const cookie=r.headers.get('set-cookie').split(';')[0];
 r=await fetch(base+'/panel/account',{headers:{cookie}});
 const csrf=(await r.text()).match(/name="csrf" value="([^"]+)"/)[1];
 r=await fetch(base+'/panel/account',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,username:'admin',old_password:'ad123456789',new_password:'VarAQ-Secure-Pass-56-ready!',confirm_password:'VarAQ-Secure-Pass-56-ready!'}),redirect:'manual'});assert.equal(r.status,303);
 r=await login('VarAQ-Secure-Pass-56-ready!');return r.headers.get('set-cookie').split(';')[0];
}
test('5.6 ISBN check digit and Persian numeral normalization distinguish invalid and valid ISBN-10/13',()=>{
 assert.equal(audit.validIsbn('978-0-306-40615-7'),true);
 assert.equal(audit.validIsbn('۹۷۸۰۳۰۶۴۰۶۱۵۷'),true);
 assert.equal(audit.validIsbn('0-306-40615-2'),true);
 assert.equal(audit.validIsbn('978-0-306-40615-8'),false);
 assert.equal(audit.validIsbn('ABC'),false);
 assert.equal(audit.normalTitle('كتابِ خوب'),audit.normalTitle('کتاب خوب'));
});
test('5.6 consistency report finds title and ISBN conflicts, dubious descriptions and never edits source records',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 const before=db.prepare('SELECT count(*) n FROM books').get().n;
 db.prepare('UPDATE books SET title=?,isbn=?,description=? WHERE id=1').run('کتاب تکراری آزمایش','9780306406157','<script>placeholder</script>');
 db.prepare('UPDATE books SET title=?,isbn=?,description=? WHERE id=2').run('كتاب تکراری آزمایش','۹۷۸۰۳۰۶۴۰۶۱۵۷','معرفی کوتاه');
 db.prepare('UPDATE books SET isbn=? WHERE id=3').run('9780306406158');
 db.prepare("INSERT INTO book_covers(book_id,filename,mime,alt,source,rights_note) VALUES(4,?,'image/png','آزمایش','منبع تست','بدون انتشار')").run('a'.repeat(32)+'.png');
 const rows=audit.scan(db,s.dir),m=new Map(rows.map(x=>[x.id,x]));assert.equal(rows.length,1000);
 for(const id of [1,2]){assert.ok(m.get(id).issues.some(x=>x.code==='isbn_conflict'));assert.ok(m.get(id).issues.some(x=>x.code==='duplicate_title'));}
 assert.ok(m.get(3).issues.some(x=>x.code==='invalid_isbn'));
 assert.ok(m.get(4).issues.some(x=>x.code==='damaged_cover')); 
 assert.ok(m.get(1).issues.some(x=>x.code==='suspect_description'));
 assert.ok(m.get(2).issues.some(x=>x.code==='short_description'));
 const result=audit.select(rows,{mode:'isbn',q:'9780306406157'});
 assert.equal(result.total,2);assert.equal(result.items[0].priority,3);
 assert.equal(audit.select(rows,{mode:'isbn',page:999}).page,audit.select(rows,{mode:'isbn'}).totalPages);
 const sum=audit.summary(rows);assert.ok(sum.invalidISBN>=1);assert.equal(sum.conflictingISBN>=2,true);
 assert.equal(db.prepare('SELECT count(*) n FROM books').get().n,before);
 assert.equal(db.prepare('SELECT isbn FROM books WHERE id=1').get().isbn,'9780306406157');
});
test('5.6 private panel, query filter, CSV formula safety, HTML escaping, seller isolation, payment lock',async t=>{
 const s=await boot(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 let r=await fetch(s.base+'/panel/catalog-consistency',{redirect:'manual'});assert.equal(r.status,303);
 const cookie=await owner(s.base);
 db.prepare('UPDATE books SET title=?,isbn=? WHERE id=1').run('=1+2 <img src=x onerror=alert(1)>','9780306406158');
 r=await fetch(s.base+'/panel/catalog-consistency?issue=isbn',{headers:{cookie}});assert.equal(r.status,200);
 let html=await r.text();assert.match(html,/کنترل کیفیت شابک/);assert.match(html,/شابک نامعتبر/);
 r=await fetch(s.base+'/panel/catalog-consistency?issue=all&q=%3Cimg',{headers:{cookie}});html=await r.text();assert.equal(r.status,200);
 assert.doesNotMatch(html,/<img src=x onerror=alert/);assert.match(html,/&lt;img/);
 r=await fetch(s.base+'/panel/catalog-consistency.csv?issue=isbn&q=%3Cimg',{headers:{cookie}});assert.equal(r.status,200);
 const csv=await r.text();assert.match(csv,/'=1\+2/);assert.match(csv,/invalid_isbn/);
 assert.match(r.headers.get('content-type'),/text\/csv/);assert.match(r.headers.get('cache-control'),/no-store/);
 assert.match(r.headers.get('x-content-type-options'),/nosniff/);
 const hash=db.prepare("SELECT password_hash FROM users WHERE role='owner'").get().password_hash;
 const store=db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get();
 db.prepare("INSERT INTO users(username,password_hash,role,store_id,enabled,must_change_password,staff_permission) VALUES(?,?,'seller',?,1,0,'manager')").run('seller56',hash,store.id);
 r=await fetch(s.base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'seller56',password:'VarAQ-Secure-Pass-56-ready!'}),redirect:'manual'});
 const seller=r.headers.get('set-cookie').split(';')[0];
 for(const dest of ['/panel/catalog-consistency','/panel/catalog-consistency.csv']){
  r=await fetch(s.base+dest,{headers:{cookie:seller}});assert.equal(r.status,403,dest);
 }
 const health=await(await fetch(s.base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
});
