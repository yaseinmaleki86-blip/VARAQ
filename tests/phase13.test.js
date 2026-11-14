'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {DatabaseSync}=require('node:sqlite');
const catalog=require('../lib/catalog-workflow');
const sampleText='این کتاب نمونه‌ای برای بررسی فرایند تکمیل اطلاعات کتاب است و متن باید با یک منبع معتبر مقایسه و تأیید شود.';
async function freePort(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>s.close(()=>resolve(s.address()?.port||0)));const original=s.close.bind(s);s.close=(cb)=>{const port=s.address().port;original(()=>{s.address=()=>({port});cb();});};});}
async function launch(storage){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:storage,PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let logs='';const promise=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Startup timeout '+logs)),12000);proc.stdout.on('data',b=>{logs+=b;if(logs.includes('PAYMENT: DISABLED')){clearTimeout(timeout);resolve();}});proc.stderr.on('data',b=>logs+=b);proc.on('exit',c=>reject(new Error('exit '+c+logs)));});await promise;return {proc,root:`http://127.0.0.1:${port}`};}
async function get(s,p,cookie=''){return fetch(s.root+p,{headers:{cookie},redirect:'manual'});}
async function post(s,p,fields,cookie=''){return fetch(s.root+p,{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields),redirect:'manual'});}
function cookie(res){return res.headers.get('set-cookie').split(';')[0];}
function csrf(html){return html.match(/name="csrf" value="([^"]+)"/)?.[1];}
async function admin(s){let r=await post(s,'/login',{username:'admin',password:'ad123456789'});let session=cookie(r);r=await get(s,'/panel/account',session);const token=csrf(await r.text());r=await post(s,'/panel/account',{csrf:token,username:'admin',old_password:'ad123456789',new_password:'strongAdminPassword333',confirm_password:'strongAdminPassword333'},session);assert.equal(r.status,303);r=await post(s,'/login',{username:'admin',password:'strongAdminPassword333'});session=cookie(r);const h=await (await get(s,'/panel/catalog-quality',session)).text();return {session,token:csrf(h)};}
async function withServer(t,run){const storage=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-v13-'));const s=await launch(storage);t.after(()=>{s.proc.kill('SIGINT');fs.rmSync(storage,{recursive:true,force:true});});await run({...s,storage});}
test('quality dashboard is private; CSV exports only verified missing fields without Excel formulas',async t=>withServer(t,async s=>{
 let r=await get(s,'/panel/catalog-quality');assert.equal(r.status,303);
 const a=await admin(s);r=await get(s,'/panel/catalog-quality',a.session);let html=await r.text();assert.equal(r.status,200);assert.match(html,/کیفیت بانک کتاب/);assert.match(html,/نویسنده ناقص/);
 r=await get(s,'/panel/catalog-template.csv',a.session);assert.equal(r.status,200);const csv=await r.text();assert.match(csv,/book_id,title,author,description,source_url,source_note/);assert.match(csv,/ملت عشق/);
 assert.equal((await get(s,'/panel/catalog-template.csv')).status,303);
 const db=new DatabaseSync(path.join(s.storage,'varaq.sqlite'));db.prepare('INSERT INTO books(id,slug,title,author,category) VALUES(?,?,?,?,?)').run(999,'dangerous', '=DANGER()','','رمان و ادبیات جهان');db.close();
 const newCsv=await (await get(s,'/panel/catalog-template.csv',a.session)).text();assert.match(newCsv,/"'=DANGER\(\)"/);
}));
test('approval is required, rejects insecure source and does not overwrite existing author',async t=>withServer(t,async s=>{
 const a=await admin(s);const fields={csrf:a.token,book_id:'5',author:'نویسنده آزمایشی',description:sampleText,source_note:'مطابقت با شناسنامه چاپ نزد کتاب‌فروشی'};
 let r=await post(s,'/panel/catalog-draft', {...fields,source_url:'http://example.org/book'},a.session);assert.equal(r.status,400);
 r=await post(s,'/panel/catalog-draft',fields,a.session);assert.equal(r.status,303);
 r=await get(s,'/book/book-005');assert.doesNotMatch(await r.text(),/نویسنده آزمایشی/);
 const db=new DatabaseSync(path.join(s.storage,'varaq.sqlite'));let draft=db.prepare('SELECT id,status FROM catalog_metadata_drafts WHERE book_id=5').get();assert.equal(draft.status,'pending');
 r=await post(s,'/panel/catalog-moderate',{csrf:a.token,draft_id:String(draft.id),action:'approve'},a.session);assert.equal(r.status,409);
 r=await post(s,'/panel/editorial-qa',{csrf:a.token,draft_id:String(draft.id),author_checked:'1',synopsis_checked:'1',review_note:'نام اثر و نویسنده و محتوای متن با مدرک فروشگاه تطبیق داده شد.'},a.session);assert.equal(r.status,303);
 r=await post(s,'/panel/catalog-moderate',{csrf:a.token,draft_id:String(draft.id),action:'approve'},a.session);assert.equal(r.status,303);
 assert.equal(db.prepare('SELECT author FROM books WHERE id=5').get().author,'نویسنده آزمایشی');assert.equal(db.prepare('SELECT status FROM catalog_metadata_drafts WHERE book_id=5').get().status,'approved');db.close();
 r=await get(s,'/book/book-005');assert.match(await r.text(),/نویسنده آزمایشی/);
 r=await post(s,'/panel/catalog-draft',{...fields,author:'نویسنده دیگر'},a.session);assert.equal(r.status,400);
}));
test('CSV import is atomic; invalid row rolls back other rows, rejected drafts remain hidden',async t=>withServer(t,async s=>{
 const a=await admin(s);const db=new DatabaseSync(path.join(s.storage,'varaq.sqlite'));
 const text=sampleText.replaceAll(',',' ');
 const badCsv=`book_id,title,author,description,source_url,source_note\n5,جزء از کل,نویسنده آ,${text},,بررسی کتاب\n99999,غیرواقعی,نویسنده ب,${text},,بررسی کتاب`;
 let r=await post(s,'/panel/catalog-import',{csrf:a.token,confirm:'1',csv:badCsv},a.session);assert.equal(r.status,400);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM catalog_metadata_drafts').get().n,0);
 const goodCsv=`book_id,title,author,description,source_url,source_note\n5,جزء از کل,نویسنده نمونه یک,${text},,بررسی کتاب\n14,کتاب دیگر,نویسنده نمونه دو,${text},,بررسی کتاب`;
 // Choose ID 6 which is populated, so only update description.
 const csv=goodCsv.replace('14,کتاب دیگر,نویسنده نمونه دو,','6,جنایت و مکافات,,');
 r=await post(s,'/panel/catalog-import',{csrf:a.token,confirm:'1',csv},a.session);assert.equal(r.status,303);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM catalog_metadata_drafts WHERE status='pending'").get().n,2);
 const first=db.prepare('SELECT id FROM catalog_metadata_drafts WHERE book_id=5').get().id;
 r=await post(s,'/panel/catalog-moderate',{csrf:a.token,draft_id:String(first),action:'reject',reason:'منبع کافی نیست'},a.session);assert.equal(r.status,303);
 assert.equal(db.prepare('SELECT author FROM books WHERE id=5').get().author,'');
 assert.equal(db.prepare('SELECT status FROM catalog_metadata_drafts WHERE id=?').get(first).status,'rejected');
 db.close();
}));
test('seller cannot access moderation or submit forged catalogue metadata; CSRF enforced',async t=>withServer(t,async s=>{
 const a=await admin(s);
 let r=await post(s,'/panel/user',{csrf:a.token,username:'bookseller13',password:'booksellerPassword123',store_id:'1'},a.session);assert.equal(r.status,303);
 r=await post(s,'/login',{username:'bookseller13',password:'booksellerPassword123'});const seller=cookie(r);
 r=await get(s,'/panel/catalog-quality',seller);assert.equal(r.status,403);
 r=await get(s,'/panel/catalog-drafts',seller);assert.equal(r.status,403);
 r=await post(s,'/panel/catalog-draft',{csrf:a.token,book_id:'5',author:'Injected',source_note:'fake'},seller);assert.equal(r.status,403);
 r=await post(s,'/panel/catalog-draft',{book_id:'5',author:'Injected',source_note:'fake'},a.session);assert.equal(r.status,403);
}));
test('workflow module is non-destructive, duplicate CSV rejected, and pending approval conflict refuses overwrite',async t=>withServer(t,async s=>{
 const a=await admin(s);const db=new DatabaseSync(path.join(s.storage,'varaq.sqlite'));
 const csv='book_id,author,description,source_url,source_note\n5,نویسنده نمونه,,https://example.org/ref,اطلاعات معتبر\n5,نویسنده نمونه دوم,,https://example.org/ref,اطلاعات معتبر';
 assert.throws(()=>catalog.batch(db,csv,1),/تکراری/);
 const id=catalog.upsertDraft(db,{book_id:5,author:'نام پیشنهادی',source_note:'شناسنامه کتاب'},1);
 assert.equal(id,5);db.prepare("UPDATE books SET author='ویرایش همزمان' WHERE id=5").run();
 const draft=db.prepare('SELECT id FROM catalog_metadata_drafts WHERE book_id=5').get();
 assert.throws(()=>catalog.moderate(db,draft.id,'approve',1),/نویسنده از قبل/);
 assert.equal(db.prepare('SELECT status FROM catalog_metadata_drafts WHERE id=?').get(draft.id).status,'pending');
 assert.equal(db.prepare('SELECT author FROM books WHERE id=5').get().author,'ویرایش همزمان');db.close();
}));
