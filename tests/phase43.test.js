'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const operations=require('../lib/store-operations');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
function setupDb(){
 const db=new DatabaseSync(':memory:');
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE stores(id INTEGER PRIMARY KEY,name TEXT,slug TEXT,city TEXT,active INTEGER,review_status TEXT);
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,role TEXT,store_id INTEGER,enabled INTEGER);
 CREATE TABLE stock_items(id INTEGER PRIMARY KEY,store_id INTEGER,active INTEGER,quantity INTEGER,min_quantity INTEGER);
 CREATE TABLE demo_orders(id INTEGER PRIMARY KEY,store_id INTEGER);
 INSERT INTO stores VALUES(1,'فروشگاه الف','alpha','یزد',1,'submitted');
 INSERT INTO stores VALUES(2,'=1+2','beta','یزد',0,'unverified');
 INSERT INTO users VALUES(1,'ymadmin','owner',NULL,1);
 INSERT INTO users VALUES(2,'seller-a','seller',1,1);
 INSERT INTO users VALUES(3,'seller-b','seller',2,1);
 INSERT INTO stock_items VALUES(1,1,1,1,2);
 INSERT INTO stock_items VALUES(2,1,1,6,2);
 INSERT INTO stock_items VALUES(3,2,0,0,2);
 INSERT INTO demo_orders VALUES(1,1);`);
 operations.migrate(db);operations.migrate(db);
 return db;
}
test('4.3 store operations aggregates tenant-scoped stock and demo numbers, with safe CSV',()=>{
 const db=setupDb();try{
 let rows=operations.allStores(db);assert.equal(rows.length,2);
 const first=rows.find(x=>x.id===1);assert.equal(first.sku_count,2);assert.equal(first.low_stock,1);assert.equal(first.demo_orders,1);assert.equal(first.active_users,1);
 const summary=operations.overview(rows);assert.equal(summary.pendingReview,1);assert.equal(summary.lowStock,1);
 rows=operations.allStores(db,{storeId:2});assert.equal(rows.length,1);assert.equal(rows[0].name,'=1+2');
 const csv=operations.csv(rows);assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/"'=1\+2"/);assert.doesNotMatch(csv,/seller-a|password_hash|customer_alias/);
 assert.throws(()=>operations.allStores(db,{review:'bogus'}),/فیلتر/);
 }finally{db.close();}
});
test('4.3 follow-up tasks validate, revision-protect, and keep tenant-isolated history',()=>{
 const db=setupDb();try{
 assert.throws(()=>operations.create(db,{storeId:999,actorId:1,title:'نامه برای ناشر',taskType:'documents'}),/فروشگاه/);
 assert.throws(()=>operations.create(db,{storeId:1,actorId:1,title:'نامه',taskType:'documents'}),/معتبر/);
 assert.throws(()=>operations.create(db,{storeId:1,actorId:1,title:'نامه به ناشر',taskType:'documents',dueDate:'2026-02-30'}),/معتبر/);
 const id=operations.create(db,{storeId:1,actorId:1,title:'درخواست پروانه معتبر',taskType:'documents',priority:'high',dueDate:'2026-11-15',note:'بررسی مورد نیاز'});
 assert.equal(operations.tasks(db,{storeId:2}).length,0);
 assert.equal(operations.tasks(db,{storeId:1}).length,1);
 assert.equal(operations.update(db,{taskId:id,storeId:1,actorId:2,status:'in_progress',expectedRevision:1,note:'پیگیری شده'}),2);
 assert.throws(()=>operations.update(db,{taskId:id,storeId:1,actorId:2,status:'done',expectedRevision:1,note:'تمام'}),/قبلاً تغییر/);
 assert.throws(()=>operations.update(db,{taskId:id,storeId:2,actorId:3,status:'done',expectedRevision:2,note:'تمام'}),/پیدا نشد/);
 assert.equal(operations.tasks(db,{storeId:1,status:'in_progress'})[0].revision,2);
 assert.equal(operations.history(db,id,1).length,2);
 assert.equal(operations.history(db,id,2).length,0);
 }finally{db.close();}
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function serve(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq43-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const base=`http://127.0.0.1:${port}`;
 const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,VARAQ_CURATED_SEED:'1'};
 delete env.PUBLIC_URL;
 let logs='';const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),pause(3000)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(logs);try{const r=await fetch(base+'/health');if(r.ok)return {dir,base};}catch{}await pause(40);}throw Error('Not ready '+logs);
}
function form(base,route,data,cookie=''){return fetch(base+route,{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data)});}
function get(base,route,cookie=''){return fetch(base+route,{redirect:'manual',headers:{cookie}});}
function csrf(html){return html.match(/name="csrf" value="([^"]+)"/)?.[1];}
function cookie(r){return r.headers.get('set-cookie')?.split(';')[0];}
test('4.3 HTTP admin, seller tenancy, CSRF, version, and disabled payment',async t=>{
 const {base,dir}=await serve(t);
 const health=await(await get(base,'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
 let r=await form(base,'/login',{username:'admin',password:'ad123456789'});let adminCookie=cookie(r);
 r=await get(base,'/panel/account',adminCookie);const securityToken=csrf(await r.text());
 r=await form(base,'/panel/account',{csrf:securityToken,username:'admin',old_password:'ad123456789',new_password:'NewPassForOwner123',confirm_password:'NewPassForOwner123'},adminCookie);assert.equal(r.status,303);
 r=await form(base,'/login',{username:'admin',password:'NewPassForOwner123'});adminCookie=cookie(r);
 r=await get(base,'/panel/store-operations',adminCookie);assert.equal(r.status,200);let html=await r.text();assert.match(html,/نمای عملیاتی کتاب‌فروشی‌ها/);const token=csrf(html);assert.ok(token);
 r=await form(base,'/panel/store-task-create',{csrf:'invalid',store_id:1,title:'آماده‌سازی مجوز فروشگاه',task_type:'documents',priority:'high'},adminCookie);assert.equal(r.status,403);
 r=await form(base,'/panel/store-task-create',{csrf:token,store_id:1,title:'آماده‌سازی مجوز فروشگاه',task_type:'documents',priority:'high',due_date:'2026-11-15',note:'متن پیگیری'},adminCookie);assert.equal(r.status,303);
 r=await form(base,'/panel/store',{csrf:token,name:'فروشگاه دو',slug:'second-store',city:'یزد'},adminCookie);assert.equal(r.status,303);
 for(const [username,id] of [['seller-aa','1'],['seller-bb','2']]){
   r=await form(base,'/panel/user',{csrf:token,username,password:'SafeSellerPassword123',store_id:id},adminCookie);assert.equal(r.status,303);
 }
 r=await get(base,'/panel/store-operations.csv',adminCookie);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/csv/);assert.match(await r.text(),/فروشگاه/);
 const database=new DatabaseSync(path.join(dir,'varaq.sqlite'));
 let taskId;try{taskId=database.prepare('SELECT id FROM store_followup_tasks').get().id;}finally{database.close();}
 r=await form(base,'/login',{username:'seller-aa',password:'SafeSellerPassword123'});const sellerCookie=cookie(r);
 r=await get(base,'/panel/store-operations',sellerCookie);assert.equal(r.status,200);html=await r.text();assert.match(html,/آماده‌سازی مجوز فروشگاه/);assert.doesNotMatch(html,/ایجاد پیگیری برای کتاب‌فروشی/);const sellerToken=csrf(html);
 r=await get(base,'/panel/store-operations?store=2',sellerCookie);assert.equal(r.status,200);assert.match(await r.text(),/آماده‌سازی مجوز فروشگاه/,'other requested store ignored');
 r=await get(base,'/panel/store-operations.csv',sellerCookie);assert.equal(r.status,403);
 r=await form(base,'/panel/store-task-create',{csrf:sellerToken,store_id:1,title:'مداخله فروشنده در ایجاد',task_type:'other'},sellerCookie);assert.equal(r.status,403);
 r=await form(base,'/panel/store-task-update',{csrf:sellerToken,store_id:2,task_id:taskId,revision:1,status:'done',note:'نامعتبر'},sellerCookie);assert.equal(r.status,403);
 r=await form(base,'/panel/store-task-update',{csrf:sellerToken,store_id:1,task_id:taskId,revision:1,status:'in_progress',note:'گزارش پیگیری'},sellerCookie);assert.equal(r.status,303);
 r=await form(base,'/panel/store-task-update',{csrf:sellerToken,store_id:1,task_id:taskId,revision:1,status:'done',note:'قدیمی'},sellerCookie);assert.equal(r.status,409);
 r=await form(base,'/login',{username:'seller-bb',password:'SafeSellerPassword123'});const otherCookie=cookie(r);
 r=await get(base,'/panel/store-operations',otherCookie);assert.equal(r.status,200);html=await r.text();assert.doesNotMatch(html,/آماده‌سازی مجوز فروشگاه/);const otherToken=csrf(html);
 r=await form(base,'/panel/store-task-update',{csrf:otherToken,store_id:1,task_id:taskId,revision:2,status:'done',note:'دخالت'},otherCookie);assert.equal(r.status,403);
 r=await get(base,'/panel/store-operations?history='+taskId,otherCookie);assert.doesNotMatch(await r.text(),/گزارش پیگیری/);
 const verify=new DatabaseSync(path.join(dir,'varaq.sqlite'),{readOnly:true});try{const item=verify.prepare('SELECT * FROM store_followup_tasks WHERE id=?').get(taskId);assert.equal(item.store_id,1);assert.equal(item.status,'in_progress');assert.equal(item.revision,2);}finally{verify.close();}
});
