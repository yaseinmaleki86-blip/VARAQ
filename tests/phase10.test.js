'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const education=require('../lib/education');
const root=path.resolve(__dirname,'..');
function port(){return new Promise(ok=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p));});});}
async function setup(t,{withOld=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-phase10-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 if(withOld){
  fs.mkdirSync(dir,{recursive:true});const d=new DatabaseSync(path.join(dir,'varaq.sqlite'));
  d.exec("CREATE TABLE books(id INTEGER PRIMARY KEY,slug TEXT,title TEXT,author TEXT,category TEXT,description TEXT,publisher TEXT,isbn TEXT,created_at TEXT); CREATE TABLE stores(id INTEGER PRIMARY KEY,name TEXT,slug TEXT UNIQUE,city TEXT,phone TEXT,about TEXT,active INTEGER,created_at TEXT); CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,password_hash TEXT,role TEXT,store_id INTEGER,created_at TEXT);");
  d.prepare("INSERT INTO books(id,slug,title,author,category) VALUES(?,?,?,?,?)").run(999,'old-educ-test','کتاب قبلی محفوظ','نویسنده','فلسفه و تاریخ');d.close();
 }
 const p=await port(),base=`http://127.0.0.1:${p}`;
 const proc=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(p),DATA_DIR:dir,PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let logs='';proc.stdout.on('data',b=>logs+=b);proc.stderr.on('data',b=>logs+=b);
 t.after(()=>proc.kill('SIGINT'));
 for(let i=0;i<70;i++){if(proc.exitCode!==null)throw Error('server stopped '+logs);try{const h=await fetch(base+'/health');if(h.ok)break;}catch{}await new Promise(r=>setTimeout(r,80));}
 return {base,dir,proc,db:new DatabaseSync(path.join(dir,'varaq.sqlite')),logs:()=>logs};
}
const get=(s,u,cookie='')=>fetch(s.base+u,{headers:{cookie},redirect:'manual'});
const post=(s,u,data,cookie='')=>fetch(s.base+u,{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data),redirect:'manual'});
const cookie=r=>r.headers.get('set-cookie')?.split(';')[0];
const csrf=html=>html.match(/name="csrf" value="([^"]+)"/)?.[1];
async function loginOwner(s){let r=await post(s,'/login',{username:'admin',password:'ad123456789'}),c=cookie(r);let html=await(await get(s,'/panel/account',c)).text();r=await post(s,'/panel/account',{csrf:csrf(html),username:'admin',old_password:'ad123456789',new_password:'StrongEduPass888',confirm_password:'StrongEduPass888'},c);assert.equal(r.status,303);return cookie(await post(s,'/login',{username:'admin',password:'StrongEduPass888'}));}
test('phase10: no fabricated books; educational catalogue and SEO noindex on filtered pages',async t=>{
 const s=await setup(t);t.after(()=>s.db.close());
 const count=s.db.prepare('SELECT count(*) n FROM education_profiles').get().n;assert.equal(count,0);
 let r=await get(s,'/educational');assert.equal(r.status,200);let html=await r.text();assert.match(html,/کمک‌درسی و کنکور/);assert.match(html,/هنوز کتابی مطابق این فیلتر/);
 assert.equal((await(await get(s,'/health')).json()).payment_enabled,false);
 r=await get(s,'/sitemap.xml');assert.match(await r.text(),/\/educational/);
 r=await get(s,'/educational?grade=12&track=experimental');assert.equal(r.status,200);
 assert.match(await r.text(),/noindex,nofollow/); // local-first default
});
test('phase10: add educational profile, filter, change visibility, protect admin operations',async t=>{
 const s=await setup(t);t.after(()=>s.db.close());const db=s.db;
 const owner=await loginOwner(s);
 const insert=db.prepare("INSERT INTO books(slug,title,author,category,publisher) VALUES(?,?,?,?,?)").run('edu-sample','زیست دوازدهم نمونه','مدرس آزمایشی','کمک‌درسی و کنکور','ناشر آزمایشی');
 const id=Number(insert.lastInsertRowid);
 let r=await get(s,'/panel/education',owner);assert.equal(r.status,200);let html=await r.text();const token=csrf(html);assert.ok(token);
 const data={csrf:token,book_id:String(id),grade:'12',track:'experimental',subject:'زیست‌شناسی',goal:'test',material_type:'tests',exam_year:'1406',published:'1'};
 r=await post(s,'/panel/education-save',data);assert.equal(r.status,303,'anonymous request is redirected to login');assert.equal(r.headers.get('location'),'/login');
 r=await post(s,'/panel/education-save',data,owner);assert.equal(r.status,303);assert.equal(db.prepare('SELECT published FROM education_profiles WHERE book_id=?').get(id).published,1);
 r=await get(s,'/educational?grade=12&track=experimental&subject='+encodeURIComponent('زیست‌شناسی'));
 html=await r.text();assert.match(html,/زیست دوازدهم نمونه/);assert.match(html,/زیست‌شناسی/);
 r=await get(s,'/educational?publisher='+encodeURIComponent('ناشر آزمایشی')+'&exam_year=1406');assert.match(await r.text(),/زیست دوازدهم نمونه/);
 r=await get(s,'/educational?publisher='+encodeURIComponent('ناشر ناموجود'));assert.doesNotMatch(await r.text(),/زیست دوازدهم نمونه/);
 r=await get(s,'/educational?grade=11&track=experimental');assert.doesNotMatch(await r.text(),/زیست دوازدهم نمونه/);
 r=await get(s,'/educational?grade=12&track=mathematics');assert.doesNotMatch(await r.text(),/زیست دوازدهم نمونه/);
 r=await get(s,'/book/edu-sample');assert.match(await r.text(),/سال کنکور/);
 r=await post(s,'/panel/education-save',{...data,grade:'7',track:'experimental'},owner);assert.equal(r.status,400);
 assert.equal(db.prepare('SELECT grade FROM education_profiles WHERE book_id=?').get(id).grade,12);
 r=await post(s,'/panel/education-save',{...data,published:'0'},owner);assert.equal(r.status,303);
 r=await get(s,'/educational');assert.doesNotMatch(await r.text(),/زیست دوازدهم نمونه/);
 r=await get(s,'/book/edu-sample');assert.doesNotMatch(await r.text(),/سال کنکور/);
 assert.equal(db.prepare('SELECT count(*) n FROM books WHERE id=?').get(id).n,1,'unpublishing profile must not delete a book');
});
test('phase10: validated values, escaping SQL wildcard, no cross-store write',async t=>{
 const s=await setup(t);t.after(()=>s.db.close());const db=s.db,owner=await loginOwner(s);
 const id=db.prepare("INSERT INTO books(slug,title,author,category) VALUES('edu-wild','کتاب درصد 100%','نمونه','فلسفه و تاریخ')").run().lastInsertRowid;
 education.upsert(db,{book_id:id,grade:'13',track:'humanities',subject:'فلسفه و منطق',goal:'review',material_type:'summary',published:'1'});
 let r=await get(s,'/educational?q=100%');assert.match(await r.text(),/کتاب درصد 100%/);
 r=await get(s,'/educational?q=_');assert.doesNotMatch(await r.text(),/کتاب درصد 100%/);
 for(const year of ['1399','1501','1406abc','2e3'])assert.throws(()=>education.validate({book_id:id,grade:13,track:'humanities',subject:'فلسفه و منطق',goal:'review',material_type:'summary',exam_year:year}),/سال/);
 const csrfToken=csrf(await(await get(s,'/panel/users',owner)).text());
 r=await post(s,'/panel/user',{csrf:csrfToken,username:'sellerEdu',password:'sellerEducation1234',store_id:'1'},owner);assert.equal(r.status,303);
 const seller=cookie(await post(s,'/login',{username:'sellerEdu',password:'sellerEducation1234'}));
 r=await get(s,'/panel/education',seller);assert.equal(r.status,403);
 r=await post(s,'/panel/education-save',{csrf:csrfToken,book_id:String(id),grade:'10',track:'mathematics',subject:'فیزیک',goal:'test',material_type:'tests',published:'1'},seller);assert.equal(r.status,403);
 assert.equal(db.prepare('SELECT grade FROM education_profiles WHERE book_id=?').get(id).grade,13);
});
test('phase10: old database migrates additively, keeps old books and stores',async t=>{
 const s=await setup(t,{withOld:true});t.after(()=>s.db.close());
 assert.equal(s.db.prepare('SELECT title FROM books WHERE id=999').get().title,'کتاب قبلی محفوظ');
 assert.ok(s.db.prepare("SELECT name FROM sqlite_master WHERE name='education_profiles'").get());
 assert.equal(s.db.prepare('SELECT count(*) n FROM education_profiles').get().n,0);
});
