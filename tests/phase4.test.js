'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const net=require('node:net');
const {DatabaseSync}=require('node:sqlite');
async function freePort(){return new Promise((ok,fail)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>ok(n));});s.on('error',fail);});}
async function start(storage){const port=await freePort(),s=spawn(process.execPath,['server.js'],{cwd:join(__dirname,'..'),env:{...process.env,DATA_DIR:storage,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let text='';let ok,fail;const ready=new Promise((resolve,reject)=>{ok=resolve;fail=reject;});const add=b=>{text+=b.toString();if(text.includes('PAYMENT: DISABLED'))ok();};s.stdout.on('data',add);s.stderr.on('data',add);s.on('exit',c=>fail(new Error(`Server stopped (${c}): ${text}`)));const timer=setTimeout(()=>fail(new Error('startup timeout: '+text)),10000);await ready.finally(()=>clearTimeout(timer));return {base:`http://127.0.0.1:${port}`,proc:s};}
const get=(s,url,cookie='')=>fetch(s.base+url,{headers:{cookie},redirect:'manual'});
const post=(s,url,data,cookie='',headers={})=>fetch(s.base+url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie,...headers},body:new URLSearchParams(data),redirect:'manual'});
const csrf=h=>h.match(/name="csrf" value="([^"]+)"/)?.[1];
const token=h=>h.match(/name="token" value="([^"]+)"/)?.[1];
const session=r=>r.headers.get('set-cookie')?.split(';')[0];
async function loginOwner(s){let r=await post(s,'/login',{username:'admin',password:'ad123456789'});let cookie=session(r);r=await get(s,'/panel/account',cookie);const c=csrf(await r.text());r=await post(s,'/panel/account',{csrf:c,username:'admin',old_password:'ad123456789',new_password:'Phase4-Secure-Pass-1234',confirm_password:'Phase4-Secure-Pass-1234'},cookie);assert.equal(r.status,303);r=await post(s,'/login',{username:'admin',password:'Phase4-Secure-Pass-1234'});assert.equal(r.status,303);return session(r);}
test('public reviews: strict validation, pending moderation, approved aggregate, XSS escaped, rate limit', async t=>{
 const dir=mkdtempSync(join(tmpdir(),'varaq-p4-'));const s=await start(dir);t.after(()=>{s.proc.kill('SIGINT');rmSync(dir,{force:true,recursive:true});});
 let r=await get(s,'/book/book-001'),html=await r.text(),signed=token(html);assert.equal(r.status,200);assert.ok(signed);assert.match(html,/هنوز امتیازی ثبت و تأیید نشده/);
 assert.match(html,/کتاب‌های مرتبط/);
 const payload={book_id:'1',token:signed,display_name:'خواننده نمونه',rating:'5',body:'این یک نظر تستی معتبر درباره تجربه مطالعه کتاب است و باید اول تأیید شود.'};
 r=await post(s,'/review',{...payload,token:'forged'});assert.equal(r.status,400);
 r=await post(s,'/review',{...payload,rating:'6'});assert.equal(r.status,400);
 r=await post(s,'/review',payload,'',{origin:'https://malicious.invalid'});assert.equal(r.status,403);
 r=await post(s,'/review',{...payload,website:'spam-link'});assert.equal(r.status,400);
 r=await post(s,'/review',payload);assert.equal(r.status,303);assert.match(r.headers.get('location'),/review=pending/);
 r=await get(s,'/book/book-001');html=await r.text();assert.doesNotMatch(html,/این یک نظر تستی معتبر/);
 const db=new DatabaseSync(join(dir,'varaq.sqlite'));assert.equal(db.prepare('SELECT status FROM reader_reviews WHERE id=1').get().status,'pending');
 const owner=await loginOwner(s);r=await get(s,'/panel/reviews',owner);html=await r.text();assert.match(html,/این یک نظر تستی معتبر/);const c=csrf(html);assert.ok(c);
 r=await post(s,'/panel/review-moderate',{csrf:c,id:'1',action:'approved'});assert.equal(r.headers.get('location'),'/login','anonymous user redirected to login');
 r=await post(s,'/panel/review-moderate',{csrf:c,id:'1',action:'approved'},owner);assert.equal(r.status,303);
 r=await get(s,'/book/book-001');html=await r.text();assert.match(html,/این یک نظر تستی معتبر/);assert.match(html,/AggregateRating/);assert.match(html,/ratingCount/);
 const second={...payload,token:token(html),display_name:'<img src=x onerror=alert(1)>',rating:'1',body:'این متن برای بررسی روش خروجی امن اچ‌تی‌ام‌ال استفاده می‌شود و تگ‌ها نباید اجرا شوند.'};
 r=await post(s,'/review',second);assert.equal(r.status,303);
 r=await post(s,'/panel/review-moderate',{csrf:c,id:'2',action:'approved'},owner);assert.equal(r.status,303);
 r=await get(s,'/book/book-001');html=await r.text();assert.doesNotMatch(html,/<img src=x onerror=/);assert.match(html,/&lt;img src=x onerror=/);
 r=await post(s,'/review',{...payload,token:token(html)});assert.equal(r.status,303);
 r=await post(s,'/review',{...payload,token:token(html)});assert.equal(r.status,429,'3 per-hour limit');
 db.close();
});
test('editorial drafts unpublished, only owner can publish, verified edition comparison and restart persistence',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'varaq-p4-'));const s=await start(dir);t.after(()=>{s.proc.kill('SIGINT');rmSync(dir,{force:true,recursive:true});});
 let owner=await loginOwner(s),r=await get(s,'/panel/editorial?book=1',owner),h=await r.text(),c=csrf(h);assert.ok(c);
 const draft={csrf:c,book_id:'1',summary:'توضیحات تحلیلی آزمایشی برای کتاب: در نسخه اول مطالب باید ابتدا تأیید شوند و نمی‌توانند بدون بررسی روی سایت نمایش داده شوند.',audience:'علاقه‌مندان به موضوع کتاب',strengths:'نکات محتوایی در دست بررسی',cautions:'نسخه چاپی را پیش از خرید تطبیق دهید'};
 r=await post(s,'/panel/editorial',draft,owner);assert.equal(r.status,303);
 r=await get(s,'/book/book-001');assert.doesNotMatch(await r.text(),/توضیحات تحلیلی آزمایشی برای کتاب/);
 r=await post(s,'/panel/editorial',{...draft,published:'1'});assert.equal(r.headers.get('location'),'/login');
 r=await post(s,'/panel/editorial',{...draft,published:'1'},owner);assert.equal(r.status,303);
 r=await get(s,'/book/book-001');assert.match(await r.text(),/توضیحات تحلیلی آزمایشی برای کتاب/);
 // Verify edition comparison only after two editions are verified.
 r=await post(s,'/panel/edition',{csrf:c,book_id:'1',label:'چاپ اول تست',publisher:'ناشر تست',isbn:'9780131103627',verified:'1'},owner);assert.equal(r.status,303);
 r=await post(s,'/panel/edition',{csrf:c,book_id:'1',label:'چاپ دوم تست',publisher:'ناشر دوم تست',isbn:'9780306406157',verified:'1'},owner);assert.equal(r.status,303);
 r=await get(s,'/book/book-001');h=await r.text();assert.match(h,/مقایسه چاپ‌ها و ترجمه‌ها/);assert.match(h,/چاپ اول تست/);assert.match(h,/چاپ دوم تست/);
 const db=new DatabaseSync(join(dir,'varaq.sqlite'));assert.equal(db.prepare('SELECT COUNT(*) n FROM book_editorials WHERE published=1').get().n,1);db.close();
});
test('phase4 migrations preserve existing data and create new tables',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'varaq-p4-'));const s=await start(dir);s.proc.kill('SIGINT');await new Promise(ok=>s.proc.once('exit',ok));
 const db=new DatabaseSync(join(dir,'varaq.sqlite'));db.prepare('UPDATE books SET title=? WHERE id=1').run('عنوان موجود نباید پاک شود');db.close();
 const again=await start(dir);t.after(()=>{again.proc.kill('SIGINT');rmSync(dir,{recursive:true,force:true});});const db2=new DatabaseSync(join(dir,'varaq.sqlite'));
 assert.equal(db2.prepare('SELECT title FROM books WHERE id=1').get().title,'عنوان موجود نباید پاک شود');
 assert.equal(db2.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('reader_reviews','book_editorials')").get().n,2);
 db2.close();
 let r=await get(again,'/health');assert.equal((await r.json()).payment_enabled,false);
});
