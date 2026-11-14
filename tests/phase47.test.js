'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const queue=require('../lib/cover-dashboard');
const catalog=require('../lib/discovery');
const pdfStore=require('../lib/pdf-store');
const pdfRights=require('../lib/pdf-rights');
const pdfUi=require('../lib/pdf-ui');
const ROOT=path.join(__dirname,'..');
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function port(){const s=net.createServer();await new Promise(ok=>s.listen(0,'127.0.0.1',ok));const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
test('4.7 completion queue finds all 200, including last page, and normalizes search safely',()=>{
 const items=Array.from({length:200},(_,i)=>({id:i+1,title:i===199?'کتاب یاسین':'کتاب شماره '+(i+1),author:i===199?'نویسنده معتبر':'',publisher:'ناشر نمونه',isbn:'',missing:i%2?['جلد مجاز']:['جلد مجاز','معرفی']}));
 const r=queue.select(items,{});assert.equal(r.total,200);assert.equal(r.pages,4);assert.equal(r.items.length,50);
 const last=queue.select(items,{page:4});assert.equal(last.items[49].id,200);
 assert.equal(queue.select(items,{page:9999}).page,4);
 const found=queue.select(items,{q:'ياسين'});assert.equal(found.total,1);assert.equal(found.items[0].id,200);
 assert.equal(queue.select(items,{missing:'description'}).total,100);
 assert.equal(queue.select(items,{missing:'__invalid__'}).total,200);
});
test('4.7 catalog verified-upload filter never counts candidates or unverified edition assets',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec(`CREATE TABLE books(id INTEGER PRIMARY KEY,title TEXT,slug TEXT,author TEXT,category TEXT,publisher TEXT,isbn TEXT);
 CREATE TABLE editions(id INTEGER PRIMARY KEY,book_id INTEGER,verified INTEGER,translator TEXT DEFAULT '',publisher TEXT DEFAULT '',isbn TEXT DEFAULT '');
 CREATE TABLE book_covers(book_id INTEGER,filename TEXT);
 CREATE TABLE edition_cover_assets(edition_id INTEGER,filename TEXT);
 CREATE TABLE stock_items(id INTEGER,book_id INTEGER,edition_id INTEGER,store_id INTEGER,active INTEGER,quantity INTEGER,price INTEGER);
 CREATE TABLE stores(id INTEGER,active INTEGER);
 INSERT INTO books VALUES(1,'اول','one','','','',''),(2,'دوم','two','','','',''),(3,'سوم','three','','','','');
 INSERT INTO editions(id,book_id,verified) VALUES(1,2,0),(2,3,1);
 INSERT INTO edition_cover_assets VALUES(1,'candidate.jpg'),(2,'actual.jpg');
 INSERT INTO book_covers VALUES(1,'local.jpg');`);
 catalog.migrate(db);
 assert.equal(catalog.search(db).total,3);
 assert.equal(catalog.search(db,{coverStatus:'uploaded'}).total,2);
 assert.deepEqual(catalog.search(db,{coverStatus:'uploaded'}).rows.map(r=>r.id),[1,3]);
 assert.deepEqual(catalog.search(db,{coverStatus:'missing'}).rows.map(r=>r.id),[2]);
 assert.equal(catalog.search(db,{coverStatus:'unknown'}).total,3);
 }finally{db.close();}
});
test('4.7 PDF dropdown does not expose inactive or expired digital listings; print cover explicitly labeled',()=>{
 const db=new DatabaseSync(':memory:');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq47-pdf-'));
 try{
 db.exec(`CREATE TABLE books(id INTEGER PRIMARY KEY,slug TEXT,title TEXT,author TEXT);
 CREATE TABLE stores(id INTEGER PRIMARY KEY,name TEXT,active INTEGER);
 CREATE TABLE users(id INTEGER PRIMARY KEY);
 CREATE TABLE editions(id INTEGER PRIMARY KEY,book_id INTEGER,verified INTEGER,translator TEXT DEFAULT '',publisher TEXT DEFAULT '',isbn TEXT DEFAULT '');
 CREATE TABLE edition_cover_assets(edition_id INTEGER,filename TEXT);
 CREATE TABLE book_covers(book_id INTEGER,filename TEXT);
 INSERT INTO books VALUES(1,'first','نسخه چاپی','مؤلف');INSERT INTO stores VALUES(1,'فروشگاه فعال',1),(2,'فروشگاه منقضی',1);INSERT INTO users VALUES(1);INSERT INTO book_covers VALUES(1,'0123456789abcdef0123456789abcdef.jpg');`);
 pdfStore.migrate(db);pdfRights.migrate(db);
 const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type/Pages/Count 0/Kids[]>>\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n');
 const info={book_id:1,title:'PDF فروشگاهی',price:'25000',rights_holder:'دارنده حقوق',rights_basis:'اجازه توزیع رسمی مستقل',rights_evidence:'سند کتبی آزمایشی معتبر',licensed:'1',original_name:'test.pdf'};
 const id1=pdfStore.create(db,dir,{role:'owner',id:1},{...info,store_id:1,rights_expires_on:'2099-12-31'},pdf);
 const id2=pdfStore.create(db,dir,{role:'owner',id:1},{...info,store_id:2,rights_expires_on:'2099-12-31'},pdf);
 for(const id of [id1,id2]){pdfStore.setStatus(db,{role:'owner',id:1},id,'pending');pdfStore.setStatus(db,{role:'owner',id:1},id,'approved');}
 db.prepare('UPDATE digital_books SET rights_expires_on=? WHERE id=?').run('2020-01-01',id2);
 const helpers={esc:x=>String(x),attr:x=>String(x),money:x=>String(x),digits:x=>String(x)};
 const page=pdfUi.publicPage(db,new URL('http://localhost/pdf-books'),helpers);
 assert.match(page,/فروشگاه فعال/);assert.doesNotMatch(page,/فروشگاه منقضی/);
 assert.match(page,/تصویر نسخه چاپی مرتبط/);assert.match(page,/پرداخت و دانلود پولی هنوز فعال نشده است/);
 assert.equal(pdfStore.publicBook(db,id2),null);
 }finally{db.close();fs.rmSync(dir,{force:true,recursive:true});}
});
test('4.7 HTTP admin list paginates all 200; filtered CSV is owner-only and payments remain disabled',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq47-http-')),PORT=await port(),base=`http://127.0.0.1:${PORT}`;
 const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,VARAQ_CURATED_SEED:'1',PUBLIC_URL:'',DATA_DIR:dir,PORT:String(PORT),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',x=>err+=x);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(ok=>child.once('exit',ok)),sleep(1500)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let k=0;k<130;k++){try{const r=await fetch(base+'/health');if(r.ok)break;}catch{}await sleep(50);if(k===129)throw Error('Server error '+err);}
 let r=await fetch(base+'/health');assert.deepEqual(await r.json(),{ok:true,version:'8.6.0',payment_enabled:false,orders_mode:'demo_only'});
 r=await fetch(base+'/books?cover=missing');assert.equal(r.status,200);const catalogHtml=await r.text();assert.match(catalogHtml,/فاقد فایل جلد بارگذاری‌شده/);assert.match(catalogHtml,/name="cover"/);
 r=await fetch(base+'/panel/cover-completion.csv?missing=author',{redirect:'manual'});assert.equal(r.status,303);
 const login=async password=>{const res=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password})});return res.headers.get('set-cookie')?.split(';')[0]};
 let cookie=await login('ad123456789');assert.ok(cookie);
 r=await fetch(base+'/panel/account',{headers:{cookie}});const csrf=(await r.text()).match(/name="csrf" value="([^"]+)"/)?.[1];assert.ok(csrf);
 r=await fetch(base+'/panel/account',{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,username:'admin',old_password:'ad123456789',new_password:'AnotherStrongVaraqPassword456!',confirm_password:'AnotherStrongVaraqPassword456!'})});assert.equal(r.status,303);
 cookie=await login('AnotherStrongVaraqPassword456!');assert.ok(cookie);
 r=await fetch(base+'/panel/cover-completion?page=4',{headers:{cookie}});assert.equal(r.status,200);const html=await r.text();assert.match(html,/صفحه ۴ از /);assert.match(html,/صفحه قبل/);
 r=await fetch(base+'/panel/cover-completion.csv?missing=author',{headers:{cookie}});assert.equal(r.status,200);const csv=await r.text();assert.ok(csv.split(/\r?\n/).length>30);assert.match(csv,/verified_isbn/);
 r=await fetch(base+'/pdf-books');assert.equal(r.status,200);
});
