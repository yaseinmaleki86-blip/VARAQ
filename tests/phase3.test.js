'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const net=require('node:net');
const {DatabaseSync}=require('node:sqlite');
const {csvParse}=require('../lib/import');
const {validateImage}=require('../lib/images');
function png100x120(){return readFileSync(join(__dirname,'fixtures','test_cover.png'));}
async function start(){const storage=mkdtempSync(join(tmpdir(),'varaq-p3-'));const srv=net.createServer();const port=await new Promise(ok=>srv.listen(0,'127.0.0.1',()=>{const p=srv.address().port;srv.close(()=>ok(p));}));const proc=spawn(process.execPath,['server.js'],{cwd:join(__dirname,'..'),env:{...process.env,DATA_DIR:storage,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let out='';await new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('start timeout '+out)),10000);proc.stdout.on('data',b=>{out+=b;if(out.includes('PAYMENT: DISABLED')){clearTimeout(timer);yes();}});proc.stderr.on('data',b=>{out+=b;});proc.on('exit',x=>no(Error('exit '+x+' '+out)));});return {storage,proc,base:`http://127.0.0.1:${port}`};}
function get(s,p,cookie=''){return fetch(s.base+p,{headers:{cookie},redirect:'manual'});}
function post(s,p,data,cookie=''){return fetch(s.base+p,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie},body:new URLSearchParams(data),redirect:'manual'});}
const csrf=h=>h.match(/name="csrf" value="([^"]+)"/)?.[1];
const cookie=r=>r.headers.get('set-cookie')?.split(';')[0];
async function auth(s){let r=await post(s,'/login',{username:'admin',password:'ad123456789'});let c=cookie(r);const h=await (await get(s,'/panel/account',c)).text();const token=csrf(h);r=await post(s,'/panel/account',{csrf:token,username:'admin',old_password:'ad123456789',new_password:'SecurePasswordForTests!99',confirm_password:'SecurePasswordForTests!99'},c);assert.equal(r.status,303);r=await post(s,'/login',{username:'admin',password:'SecurePasswordForTests!99'});c=cookie(r);const h2=await (await get(s,'/panel/categories',c)).text();return {c,token:csrf(h2)};}
test('CSV parser accepts Persian fields, escaped commas, newlines and rejects bad syntax',()=>{
 const rows=csvParse('\uFEFFtitle,author,category,description,publisher\n"اثر، نمونه","مؤلف","رمان و ادبیات جهان","خط اول\nخط دوم","ناشر"');assert.equal(rows.length,1);assert.equal(rows[0].title,'اثر، نمونه');assert.match(rows[0].description,/خط دوم/);
 assert.throws(()=>csvParse('title,category\n"خراب,رمان'),/CSV_UNCLOSED_QUOTE/);
 assert.throws(()=>validateImage(Buffer.from('<svg onload=alert(1)>')),/IMAGE_SIZE|IMAGE_DIMENSIONS/);
});
test('category CRUD, CSV preview/import, book covers, permission barriers and restart persist',async t=>{
 const s=await start();t.after(()=>{s.proc.kill();rmSync(s.storage,{recursive:true,force:true});});
 const {c,token}=await auth(s);
 let r=await post(s,'/panel/category',{csrf:token,name:'درس و کنکور',slug:'exam-education',active:'1'},c);assert.equal(r.status,303);
 r=await get(s,'/category/exam-education');assert.equal(r.status,200);
 let db=new DatabaseSync(join(s.storage,'varaq.sqlite'));
 assert.equal(db.prepare("SELECT active FROM book_categories WHERE slug='exam-education'").get().active,1);
 const csv='title,author,category,description,publisher\n"اثر آزمون الف","مؤلف الف","درس و کنکور","این یک عنوان آزمایشی است",""\n"اثر آزمون الف","مؤلف الف","درس و کنکور","تکراری",""\n"اثر بدون دسته","نویسنده","موضوع اشتباه","",""';
 r=await post(s,'/panel/import',{csrf:token,csv,mode:'preview'},c);assert.equal(r.status,200);let html=await r.text();assert.match(html,/آماده ورود/);assert.match(html,/تکراری در همین فایل/);assert.match(html,/موضوع یا طول توضیحات نامعتبر/);
 assert.equal(db.prepare("SELECT count(*) n FROM books WHERE title='اثر آزمون الف'").get().n,0,'preview cannot write');
 r=await post(s,'/panel/import',{csrf:token,csv,mode:'commit',confirm:'1'},c);assert.equal(r.status,200);assert.match(await r.text(),/کتاب افزوده شد/);
 assert.equal(db.prepare("SELECT count(*) n FROM books WHERE title='اثر آزمون الف'").get().n,1);
 r=await post(s,'/panel/import',{csrf:token,csv,mode:'commit',confirm:'1'},c);assert.equal(r.status,200);assert.equal(db.prepare("SELECT count(*) n FROM books WHERE title='اثر آزمون الف'").get().n,1,'idempotent import');
 r=await get(s,'/books?category=%D8%AF%D8%B1%D8%B3%20%D9%88%20%DA%A9%D9%86%DA%A9%D9%88%D8%B1');assert.match(await r.text(),/اثر آزمون الف/);
 r=await post(s,'/panel/category',{csrf:token,id:String(db.prepare("SELECT id FROM book_categories WHERE slug='exam-education'").get().id),name:'کمک‌درسی',slug:'exam-education',active:'1'},c);assert.equal(r.status,303);
 assert.equal(db.prepare("SELECT category FROM books WHERE title='اثر آزمون الف'").get().category,'کمک‌درسی','rename updates books');
 // standard form-data upload with wrong type rejected
 let fd=new FormData();fd.append('csrf',token);fd.append('book_id','1');fd.append('source','حق نشر من');fd.append('rights_note','مجوز معتبر');fd.append('licensed','1');fd.append('cover',new Blob(['<svg onload=alert(1)>'],{type:'image/svg+xml'}),'x.svg');
 r=await fetch(s.base+'/panel/cover-upload',{method:'POST',body:fd,headers:{cookie:c},redirect:'manual'});assert.equal(r.status,400);
 fd=new FormData();fd.append('csrf',token);fd.append('book_id','1');fd.append('source','مالک تصویر');fd.append('rights_note','حقوق استفاده تأیید شده برای آزمایش');fd.append('licensed','1');fd.append('cover',new Blob([png100x120()],{type:'image/png'}),'cover.png');
 r=await fetch(s.base+'/panel/cover-upload',{method:'POST',body:fd,headers:{cookie:c},redirect:'manual'});assert.equal(r.status,303);
 const b=db.prepare('SELECT filename FROM book_covers WHERE book_id=1').get();assert.ok(b);
 r=await get(s,'/media/covers/'+b.filename);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');
 r=await get(s,'/book/book-001');html=await r.text();assert.match(html,/cover-image-frame/);assert.match(html,/مالک تصویر/);
 // Only admin can import and upload covers. Seller receives no privilege.
 r=await post(s,'/panel/user',{csrf:token,username:'vendor-test',password:'passVendor123456789',store_id:'1'},c);assert.equal(r.status,303);
 r=await post(s,'/login',{username:'vendor-test',password:'passVendor123456789'});const vendorCookie=cookie(r);
 r=await get(s,'/panel/import',vendorCookie);assert.equal(r.status,403);
 r=await get(s,'/panel/categories',vendorCookie);assert.equal(r.status,403);
 fd=new FormData();fd.append('csrf',token);fd.append('book_id','1');fd.append('licensed','1');fd.append('cover',new Blob([png100x120()],{type:'image/png'}),'cover.png');
 r=await fetch(s.base+'/panel/cover-upload',{method:'POST',body:fd,headers:{cookie:vendorCookie},redirect:'manual'});assert.equal(r.status,403);
 assert.equal((await (await get(s,'/health')).json()).payment_enabled,false);
 assert.equal(db.prepare('SELECT count(*) n FROM books').get().n,1001);
 db.close();
});
