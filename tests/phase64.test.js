'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const review=require('../lib/generated-editorial-review');
const books=require('../data/generated_catalog_v63.json');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function mockDb(){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON; CREATE TABLE books(id INTEGER PRIMARY KEY,title TEXT,description TEXT);CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);');db.prepare('INSERT INTO users(id,username) VALUES(1,?)').run('reviewer');for(const b of books)db.prepare('INSERT INTO books(id,title,description) VALUES(?,?,?)').run(b.id,b.title,'');review.migrate(db);return db;}
test('6.4: exact-content review, evidence requirements and stale revisions',()=>{
 const db=mockDb();try{
  assert.equal(review.rows(db,books).length,200);
  let current=review.record(db,books[0]);assert.equal(current.status,'pending');
  const input={book_id:1,revision:0,content_hash:current.hash,status:'approved',source_url:'https://example.org/reviews/1',note:'خلاصه و راهنما با منبع اثر مقایسه شد'};
  assert.equal(review.update(db,books,input,1),1);
  assert.equal(review.record(db,books[0]).status,'approved');
  assert.throws(()=>review.update(db,books,input,1),/تغییر/);
  const changed=books.map((x,i)=>i===0?{...x,reader_note:x.reader_note+' نسخه جدید'}:x);
  assert.equal(review.record(db,changed[0]).status,'stale');
  assert.equal(review.rows(db,changed,{status:'stale'}).length,1);
  assert.equal(review.record(db,changed[0]).previous_status,'approved');
  const updated={...input,revision:1,content_hash:review.hash(changed[0]),status:'revise',note:'نیازمند تطبیق با منابع جدید است'};
  assert.equal(review.update(db,changed,updated,1),2);
  assert.equal(review.record(db,changed[0]).status,'revise');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM generated_editorial_review_history WHERE book_id=1').get().n,2);
 }finally{db.close();}
});
test('6.4: reject unsupported approval, malicious source, short notes; protect CSV',()=>{
 const db=mockDb();try{
  let first=review.record(db,books[0]);
  const f={book_id:1,revision:0,content_hash:first.hash,status:'approved',source_url:'javascript:alert(1)',note:'مدرک بررسی معتبر موجود است'};
  assert.throws(()=>review.update(db,books,f,1),/منبع/);
  assert.throws(()=>review.update(db,books,{...f,source_url:'https://example.org',note:''},1),/حداقل/);
  assert.throws(()=>review.update(db,books,{...f,status:'hidden',source_url:'',note:''},1),/دلیل/);
  db.prepare('UPDATE books SET title=? WHERE id=1').run('=HYPERLINK("bad","click")');
  const csv=review.csv(db,books);assert.match(csv,/\uFEFF/);assert.match(csv,/'=HYPERLINK/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM generated_editorial_reviews').get().n,0);
 }finally{db.close();}
});
async function serve(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq64-')),socket=net.createServer();
 await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const base='http://127.0.0.1:'+port,proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let errors='';proc.stderr.on('data',data=>errors+=data);
 t.after(async()=>{if(proc.exitCode===null){proc.kill();await Promise.race([new Promise(resolve=>proc.once('exit',resolve)),wait(1400)])}fs.rmSync(dir,{recursive:true,force:true})});
 for(let i=0;i<120;i++){try{if((await fetch(base+'/health')).ok)return{base,dir};}catch{}await wait(55);}throw Error('Boot failed: '+errors);
}
async function login(base){
 const sign=password=>fetch(base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password}),redirect:'manual'});
 let r=await sign('ad123456789'),cookie=r.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
 r=await fetch(base+'/panel/account',{headers:{cookie}});let html=await r.text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
 r=await fetch(base+'/panel/account',{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,username:'admin',old_password:'ad123456789',new_password:'VARAQ-64-Secure-Passphrase!',confirm_password:'VARAQ-64-Secure-Passphrase!'}),redirect:'manual'});assert.equal(r.status,303);
 r=await sign('VARAQ-64-Secure-Passphrase!');return r.headers.get('set-cookie').split(';')[0];
}
test('6.4: owner review form, CSRF, approval display, hide and no purchase',async t=>{
 const s=await serve(t),db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));t.after(()=>db.close());
 let r=await fetch(s.base+'/panel/generated-editorials',{redirect:'manual'});assert.equal(r.status,303);
 const cookie=await login(s.base),headers={cookie};
 r=await fetch(s.base+'/panel/generated-editorials?book=1',{headers});assert.equal(r.status,200);
 let html=await r.text();assert.match(html,/بازبینی ۱۰۰۰ معرفی/);assert.match(html,/ملت عشق/);
 const csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
 const f={book_id:1,revision:0,content_hash:review.hash(books[0]),status:'approved',source_url:'https://example.com/book/source',note:'با خلاصه رسمی ناشر مقابله و بررسی شده',csrf};
 r=await fetch(s.base+'/panel/generated-editorials-review',{method:'POST',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...f,csrf:'invalid'}),redirect:'manual'});assert.equal(r.status,403);
 r=await fetch(s.base+'/panel/generated-editorials-review',{method:'POST',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(f),redirect:'manual'});assert.equal(r.status,303);
 r=await fetch(s.base+'/book/book-001');html=await r.text();assert.match(html,/معرفی اختصاصی ورق · بازبینی‌شده توسط تحریریه/);assert.match(html,/منبع بررسی/);
 r=await fetch(s.base+'/panel/generated-editorials.csv',{headers});assert.equal(r.status,200);assert.match(await r.text(),/بازبینی تحریریه شده/);
 f.status='hidden';f.revision=1;f.note='اطلاعات موجود نیاز به بازبینی بیشتر دارند';f.source_url='';
 r=await fetch(s.base+'/panel/generated-editorials-review',{method:'POST',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(f),redirect:'manual'});assert.equal(r.status,303);
 r=await fetch(s.base+'/book/book-001');html=await r.text();assert.doesNotMatch(html,/روایتی درباره پیوند عشق/);assert.doesNotMatch(html,/راهنمای مطالعه اولیه/);
 const health=await(await fetch(s.base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
});
