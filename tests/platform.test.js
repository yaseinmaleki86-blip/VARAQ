'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const net=require('node:net');
const {DatabaseSync}=require('node:sqlite');
async function port(){return new Promise((ok,fail)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>ok(n));});s.on('error',fail);});}
async function start(dir){const storage=dir||mkdtempSync(join(tmpdir(),'varaq-test-'));const p=await port();const proc=spawn(process.execPath,['server.js'],{cwd:join(__dirname,'..'),env:{...process.env,DATA_DIR:storage,HOST:'127.0.0.1',PORT:String(p),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let out='';let resolve,reject;const ready=new Promise((r,j)=>{resolve=r;reject=j;});const collect=x=>{out+=x.toString();if(out.includes('PAYMENT: DISABLED'))resolve();};proc.stdout.on('data',collect);proc.stderr.on('data',collect);proc.on('exit',code=>reject(new Error('Server exited '+code+' '+out)));const timer=setTimeout(()=>reject(new Error('Startup timeout '+out)),12000);await ready.finally(()=>clearTimeout(timer));return {storage,proc,base:`http://127.0.0.1:${p}`,close(){proc.kill('SIGINT');}};}
async function get(s,p,cookie=''){return fetch(s.base+p,{headers:{cookie},redirect:'manual'});}
async function post(s,p,data,cookie=''){return fetch(s.base+p,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie},body:new URLSearchParams(data),redirect:'manual'});}
function csrfFrom(h){return h.match(/name="csrf" value="([^"]+)"/)?.[1];}
function cookieFrom(r){return r.headers.get('set-cookie')?.split(';')[0];}
const INITIAL_PASS='ad123456789';
test('fresh admin, required password change, book editions, permissions, payment locked',async t=>{
 const s=await start();t.after(()=>{s.close();rmSync(s.storage,{recursive:true,force:true});});
 let r=await get(s,'/health');assert.deepEqual(await r.json(),{ok:true,version:'8.6.0',payment_enabled:false,orders_mode:'demo_only'});
 r=await get(s,'/');assert.equal(r.status,200);assert.match(await r.text(),/۱۰۰۰ عنوان منتخب/);
 r=await get(s,'/setup');assert.equal(r.status,403);
 r=await post(s,'/login',{username:'admin',password:INITIAL_PASS});assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/panel/account');let adminCookie=cookieFrom(r);
 r=await get(s,'/panel/books',adminCookie);assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/panel/account');
 r=await get(s,'/panel/account',adminCookie);let html=await r.text();let csrf=csrfFrom(html);assert.ok(csrf);
 r=await post(s,'/panel/account',{csrf,username:'admin',old_password:'bad',new_password:'strongPassword987654',confirm_password:'strongPassword987654'},adminCookie);assert.match(await r.text(),/رمز عبور فعلی درست نیست/);
 r=await post(s,'/panel/account',{csrf,username:'admin',old_password:INITIAL_PASS,new_password:'strongPassword987654',confirm_password:'strongPassword987654'},adminCookie);assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/login?changed=1');
 r=await get(s,'/panel',adminCookie);assert.equal(r.status,303);
 r=await post(s,'/login',{username:'admin',password:INITIAL_PASS});assert.match(await r.text(),/اشتباه/);
 r=await post(s,'/login',{username:'admin',password:'strongPassword987654'});assert.equal(r.status,303);adminCookie=cookieFrom(r);
 r=await get(s,'/panel/books',adminCookie);html=await r.text();csrf=csrfFrom(html);assert.ok(csrf);
 r=await get(s,'/books');assert.match(await r.text(),/ملت عشق/);
 r=await get(s,'/book/book-001');assert.equal(r.status,200);assert.doesNotMatch(await r.text(),/ترجمه آزمایشی/);
 r=await post(s,'/panel/edition',{csrf,book_id:'1',label:'ترجمه آزمایشی',translator:'مترجم نمونه',publisher:'ناشر نمونه',isbn:'9780131103627',pages:'300',verified:'0'},adminCookie);assert.equal(r.status,303);
 r=await get(s,'/book/book-001');assert.doesNotMatch(await r.text(),/ترجمه آزمایشی/,'draft edition stays hidden');
 r=await get(s,'/panel/editions?book=1',adminCookie);html=await r.text();assert.match(html,/ترجمه آزمایشی/);assert.match(html,/نیازمند بررسی/);
 r=await post(s,'/panel/edition',{csrf,book_id:'1',id:'1',label:'ترجمه آزمایشی',translator:'مترجم نمونه',publisher:'ناشر نمونه',isbn:'9780131103627',pages:'300',verified:'1'},adminCookie);assert.equal(r.status,303);
 r=await get(s,'/book/book-001');html=await r.text();assert.match(html,/ترجمه آزمایشی/);assert.match(html,/9780131103627/);
 r=await post(s,'/panel/edition',{csrf,book_id:'1',label:'خراب',publisher:'ناشر',isbn:'9780131103628',verified:'1'},adminCookie);assert.equal(r.status,400,'invalid ISBN check digit rejected');
 r=await post(s,'/panel/edition',{csrf,book_id:'2',label:'تکراری',publisher:'ناشر',isbn:'9780131103627',verified:'1'},adminCookie);assert.equal(r.status,409,'duplicate ISBN rejected');
 r=await post(s,'/panel/edition',{csrf,book_id:'2',id:'1',label:'هک',publisher:'ناشر',isbn:'9780131103627',verified:'1'},adminCookie);assert.equal(r.status,404,'cannot change edition of other book');
 r=await post(s,'/panel/store',{csrf,name:'فروشگاه دوم',slug:'store-2',city:'یزد',active:'1'},adminCookie);assert.equal(r.status,303);
 r=await post(s,'/panel/user',{csrf,username:'seller1',password:'seller-secret-long1',store_id:'1'},adminCookie);assert.equal(r.status,303);
 r=await post(s,'/login',{username:'seller1',password:'seller-secret-long1'});assert.equal(r.status,303);const sellerCookie=cookieFrom(r);
 r=await get(s,'/panel/inventory',sellerCookie);html=await r.text();const sellerCsrf=csrfFrom(html);assert.ok(sellerCsrf);
 r=await get(s,'/panel/editions',sellerCookie);assert.equal(r.status,403);
 r=await post(s,'/panel/edition',{csrf:sellerCsrf,book_id:'2',label:'اجازه ندارد'},sellerCookie);assert.equal(r.status,404);
 // The old handler intentionally masks unmatched owner-only routes as 404.
 r=await post(s,'/panel/offer',{csrf:sellerCsrf,book_id:'1',store_id:'2',price:'30000',stock:'2',active:'1'},sellerCookie);assert.equal(r.status,403);
 r=await post(s,'/panel/offer',{csrf:sellerCsrf,book_id:'1',store_id:'1',price:'400000',stock:'3',active:'1'},sellerCookie);assert.equal(r.status,303);
 r=await get(s,'/book/book-001');assert.match(await r.text(),/۴۰۰٬۰۰۰ تومان/);
 r=await get(s,'/cart');assert.match(await r.text(),/امکان ثبت سفارش پولی وجود ندارد/);
 r=await post(s,'/logout',{csrf:sellerCsrf},sellerCookie);assert.equal(r.status,303);
});
test('owner can update username and password; old sessions are revoked',async t=>{
 const s=await start();t.after(()=>{s.close();rmSync(s.storage,{recursive:true,force:true});});
 let r=await post(s,'/login',{username:'admin',password:INITIAL_PASS});let cookie=cookieFrom(r);
 r=await get(s,'/panel/account',cookie);const csrf=csrfFrom(await r.text());
 r=await post(s,'/panel/account',{csrf,username:'newadmin',old_password:INITIAL_PASS,new_password:'newAdminSafePwd123',confirm_password:'newAdminSafePwd123'},cookie);assert.equal(r.status,303);
 r=await post(s,'/login',{username:'admin',password:'newAdminSafePwd123'});assert.notEqual(r.status,303);
 r=await post(s,'/login',{username:'newadmin',password:'newAdminSafePwd123'});assert.equal(r.status,303);
});
test('upgrade existing SQLite database keeps owner, stores and offers intact',async t=>{
 const storage=mkdtempSync(join(tmpdir(),'varaq-upgrade-test-'));
 t.after(()=>rmSync(storage,{recursive:true,force:true}));
 const db=new DatabaseSync(join(storage,'varaq.sqlite'));
 db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT,role TEXT,store_id INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE stores(id INTEGER PRIMARY KEY,name TEXT,slug TEXT UNIQUE,city TEXT,phone TEXT DEFAULT '',about TEXT DEFAULT '',active INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE books(id INTEGER PRIMARY KEY,slug TEXT,title TEXT,author TEXT,category TEXT,description TEXT,publisher TEXT,isbn TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE offers(id INTEGER PRIMARY KEY,book_id INTEGER,store_id INTEGER,price INTEGER,stock INTEGER,active INTEGER,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER,csrf TEXT,expires_at INTEGER);
 CREATE TABLE audit_log(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,resource TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 INSERT INTO users(username,password_hash,role) VALUES('existing_owner','unmodified_hash','owner');
 INSERT INTO stores(name,slug,city) VALUES('فروشگاه اصلی','store-1','یزد');
 INSERT INTO books(id,slug,title,author,category,description,publisher,isbn) VALUES(1,'book-001','نام کتاب قبلی','','رمان','','','');
 INSERT INTO offers(book_id,store_id,price,stock,active) VALUES(1,1,120000,9,1);`);db.close();
 const s=await start(storage);t.after(()=>s.close());
 let r=await get(s,'/health');assert.equal((await r.json()).version,'8.6.0');
 const newDB=new DatabaseSync(join(storage,'varaq.sqlite'));
 assert.equal(newDB.prepare('SELECT COUNT(*) c FROM users').get().c,1,'should not add admin if previous owner exists');
 assert.equal(newDB.prepare('SELECT username FROM users').get().username,'existing_owner');
 assert.equal(newDB.prepare('SELECT price FROM offers').get().price,120000);
 assert.ok(newDB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='editions'").get());
 assert.equal(newDB.prepare('SELECT must_change_password FROM users').get().must_change_password,0);
 newDB.close();
});
