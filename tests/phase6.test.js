'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const net=require('node:net');
const {DatabaseSync}=require('node:sqlite');
const root=path.join(__dirname,'..');
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});s.on('error',reject);});}
async function start(dir){const port=await freePort(),proc=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let output='';let good,fail;const ready=new Promise((r,j)=>{good=r;fail=j});const collect=c=>{output+=c.toString();if(output.includes('PAYMENT: DISABLED'))good();};proc.stdout.on('data',collect);proc.stderr.on('data',collect);proc.on('exit',code=>fail(new Error('server exited '+code+' '+output)));const timer=setTimeout(()=>fail(new Error('server not ready '+output)),10000);await ready.finally(()=>clearTimeout(timer));return {base:`http://127.0.0.1:${port}`,proc};}
const cookie=r=>r.headers.get('set-cookie')?.split(';')[0];
async function get(s,p,c){return fetch(s.base+p,{headers:c?{cookie:c}:{},redirect:'manual'});}
async function post(s,p,f,c){return fetch(s.base+p,{method:'POST',headers:{cookie:c,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(f),redirect:'manual'});}
async function csrf(s,p,c){const response=await get(s,p,c);return (await response.text()).match(/name="csrf" value="([^"]+)"/)?.[1];}
async function login(s,u,p){const r=await post(s,'/login',{username:u,password:p});return {status:r.status,c:cookie(r),location:r.headers.get('location')};}
async function owner(s){let o=await login(s,'admin','ad123456789');assert.equal(o.location,'/panel/account');const t=await csrf(s,'/panel/account',o.c);const r=await post(s,'/panel/account',{csrf:t,username:'admin',old_password:'ad123456789',new_password:'NewAdminPass8765',confirm_password:'NewAdminPass8765'},o.c);assert.equal(r.status,303);o=await login(s,'admin','NewAdminPass8765');return o.c;}
function dbOpen(dir){return new DatabaseSync(path.join(dir,'varaq.sqlite'));}

test('phase6: per-edition SKU, ledger history, stock alerts, public edition and CSV',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-stock6-'));const s=await start(dir);t.after(()=>{s.proc.kill('SIGINT');fs.rmSync(dir,{force:true,recursive:true});});
 const c=await owner(s),token=await csrf(s,'/panel/editions',c);
 let r=await post(s,'/panel/edition',{csrf:token,book_id:'1',label:'چاپ یاقوت',translator:'مترجم نمونه',publisher:'ناشر نمونه',isbn:'9780131103627',verified:'1'},c);assert.equal(r.status,303);
 const db=dbOpen(dir);t.after(()=>db.close());const eid=db.prepare('SELECT id FROM editions WHERE isbn=?').get('9780131103627').id;
 const inventoryToken=await csrf(s,'/panel/stock-item?store=1',c);
 r=await post(s,'/panel/stock-item',{csrf:inventoryToken,store_id:'1',edition_id:String(eid),sku:'YM-B001-V1',price:'270000',min_quantity:'3',active:'1'},c);assert.equal(r.status,303);
 const item=db.prepare("SELECT * FROM stock_items WHERE sku='YM-B001-V1'").get();assert.equal(item.quantity,0);assert.equal(item.book_id,1);assert.equal(item.edition_id,eid);
 let html=await (await get(s,'/book/book-001')).text();assert.doesNotMatch(html,/YM-B001-V1/,'zero stock is not advertised');
 const moveToken=await csrf(s,`/panel/stock-item?store=1&item=${item.id}`,c);
 r=await post(s,'/panel/stock-move',{csrf:moveToken,store_id:'1',item_id:String(item.id),delta:'8',reason:'receipt',note:'برگه ورود شماره ۱'},c);assert.equal(r.status,303);
 assert.equal(db.prepare('SELECT quantity FROM stock_items WHERE id=?').get(item.id).quantity,8);
 html=await (await get(s,'/book/book-001')).text();assert.match(html,/YM-B001-V1/);assert.match(html,/چاپ یاقوت/);assert.match(html,/۲۷۰٬۰۰۰ تومان/);
 r=await post(s,'/panel/stock-move',{csrf:moveToken,store_id:'1',item_id:String(item.id),delta:'-6',reason:'manual_out',note:'تحویل دستی'},c);assert.equal(r.status,303);
 let row=db.prepare('SELECT quantity,min_quantity FROM stock_items WHERE id=?').get(item.id);assert.equal(row.quantity,2);
 html=await (await get(s,'/panel/inventory?store=1&low=1',c)).text();assert.match(html,/YM-B001-V1/);assert.match(html,/کمبود/);
 r=await post(s,'/panel/stock-move',{csrf:moveToken,store_id:'1',item_id:String(item.id),delta:'-3',reason:'manual_out'},c);assert.equal(r.status,400,'cannot go negative');
 r=await post(s,'/panel/stock-move',{csrf:moveToken,store_id:'1',item_id:String(item.id),delta:'2',reason:'damage'},c);assert.equal(r.status,400,'wrong delta sign');
 r=await post(s,'/panel/stock-move',{csrf:moveToken,store_id:'1',item_id:String(item.id),delta:'1',reason:'correction',note:'bad'},c);assert.equal(r.status,400,'correction must be documented');
 assert.equal(db.prepare('SELECT quantity FROM stock_items WHERE id=?').get(item.id).quantity,2);
 const changes=db.prepare('SELECT delta,before_quantity,after_quantity FROM stock_movements WHERE item_id=? ORDER BY id').all(item.id);
 assert.deepEqual(changes.map(x=>[x.delta,x.before_quantity,x.after_quantity]),[[8,0,8],[-6,8,2]]);
 r=await get(s,'/panel/stock-ledger.csv?store=1',c);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/csv/);const csv=await r.text();assert.match(csv,/YM-B001-V1/);assert.match(csv,/برگه ورود شماره ۱/);
 const health=await (await get(s,'/health')).json();assert.deepEqual(health,{ok:true,version:'8.6.0',payment_enabled:false,orders_mode:'demo_only'});
});

test('phase6: cross-store isolation, edition validation and staff permissions',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-scope6-')),s=await start(dir);t.after(()=>{s.proc.kill('SIGINT');fs.rmSync(dir,{recursive:true,force:true});});
 const c=await owner(s),tok=await csrf(s,'/panel/stores',c);
 assert.equal((await post(s,'/panel/store',{csrf:tok,name:'کتاب‌فروشی دوم',slug:'test-second',city:'یزد'},c)).status,303);
 assert.equal((await post(s,'/panel/user',{csrf:tok,username:'storeOne',password:'StoreOneSecure123',store_id:'1'},c)).status,303);
 assert.equal((await post(s,'/panel/user',{csrf:tok,username:'storeTwo',password:'StoreTwoSecure123',store_id:'2'},c)).status,303);
 let x=await login(s,'storeOne','StoreOneSecure123'),y=await login(s,'storeTwo','StoreTwoSecure123');
 const db=dbOpen(dir);t.after(()=>db.close());
 const edToken=await csrf(s,'/panel/editions',c);
 await post(s,'/panel/edition',{csrf:edToken,book_id:'1',label:'چاپ اول',publisher:'ناشر الف',isbn:'9780131103627',verified:'1'},c);
 await post(s,'/panel/edition',{csrf:edToken,book_id:'2',label:'چاپ دوم',publisher:'ناشر ب',isbn:'9780201633610',verified:'1'},c);
 const eid=db.prepare('SELECT id FROM editions WHERE book_id=1').get().id;
 const xcsrf=await csrf(s,'/panel/stock-item',x.c);
 let r=await post(s,'/panel/stock-item',{csrf:xcsrf,store_id:'2',edition_id:String(eid),sku:'ABC-OTHER',price:'20000',min_quantity:'2',active:'1'},x.c);assert.equal(r.status,403);
 r=await post(s,'/panel/stock-item',{csrf:xcsrf,store_id:'1',edition_id:String(eid),sku:'ABC-ONE',price:'20000',min_quantity:'1',active:'1'},x.c);assert.equal(r.status,303);
 const id=db.prepare("SELECT id FROM stock_items WHERE sku='ABC-ONE'").get().id;
 const ycsrf=await csrf(s,'/panel/stock-item',y.c);
 r=await get(s,`/panel/stock-item?store=2&item=${id}`,y.c);assert.equal(r.status,403);
 r=await post(s,'/panel/stock-move',{csrf:ycsrf,store_id:'2',item_id:String(id),delta:'4',reason:'receipt'},y.c);assert.equal(r.status,400,'valid store but item belongs to other store');
 r=await get(s,'/panel/stock-ledger.csv?store=1',y.c);assert.equal(r.status,200,'seller requested store overridden by own store');assert.doesNotMatch(await r.text(),/ABC-ONE/);
 r=await post(s,'/panel/stock-item',{csrf:xcsrf,store_id:'1',edition_id:String(db.prepare('SELECT id FROM editions WHERE book_id=2').get().id),book_id:'1',sku:'ABC-MISMATCH',price:'20000',min_quantity:'1'},x.c);assert.equal(r.status,400,'mismatched edition and book correctly rejected');
 const staffToken=await csrf(s,'/panel/staff',x.c);
 await post(s,'/panel/staff',{csrf:staffToken,username:'readStock',password:'InitialViewOnly456',permission:'viewer'},x.c);
 let v=await login(s,'readStock','InitialViewOnly456');const t2=await csrf(s,'/panel/account',v.c);
 await post(s,'/panel/account',{csrf:t2,username:'readStock',old_password:'InitialViewOnly456',new_password:'NewViewerPass123',confirm_password:'NewViewerPass123'},v.c);
 v=await login(s,'readStock','NewViewerPass123');const vt=await csrf(s,'/panel/stock-item',v.c);
 r=await post(s,'/panel/stock-move',{csrf:vt,store_id:'1',item_id:String(id),delta:'1',reason:'receipt'},v.c);assert.equal(r.status,403);
 r=await post(s,'/panel/stock-item',{csrf:vt,store_id:'1',edition_id:String(eid),sku:'ABC-VIEW',price:'20000',min_quantity:'1'},v.c);assert.equal(r.status,403);
});

test('phase6: legacy balances imported exactly once and old offer endpoint stays compatible',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-migrate6-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const s=await start(dir);const c=await owner(s),tok=await csrf(s,'/panel/inventory',c);
 assert.equal((await post(s,'/panel/offer',{csrf:tok,book_id:'1',store_id:'1',price:'150000',stock:'7',active:'1'},c)).status,303);
 let db=dbOpen(dir);assert.equal(db.prepare("SELECT quantity FROM stock_items WHERE sku='LEG-1-1'").get().quantity,7);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE item_id=(SELECT id FROM stock_items WHERE sku='LEG-1-1')").get().n,1);db.close();s.proc.kill('SIGINT');
 await new Promise(r=>s.proc.once('exit',r));
 const r2=await start(dir);t.after(()=>r2.proc.kill('SIGINT'));
 db=dbOpen(dir);t.after(()=>db.close());
 assert.equal(db.prepare("SELECT quantity FROM stock_items WHERE sku='LEG-1-1'").get().quantity,7);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE item_id=(SELECT id FROM stock_items WHERE sku='LEG-1-1')").get().n,1,'migration is idempotent');
 assert.equal(db.prepare('SELECT stock FROM offers WHERE store_id=1 AND book_id=1').get().stock,7);
 const o=await login(r2,'admin','NewAdminPass8765');const ot=await csrf(r2,'/panel/inventory',o.c);
 const r=await post(r2,'/panel/offer',{csrf:ot,book_id:'1',store_id:'1',price:'150000',stock:'5',active:'1'},o.c);assert.equal(r.status,303);
 assert.equal(db.prepare("SELECT quantity FROM stock_items WHERE sku='LEG-1-1'").get().quantity,5);
 assert.equal(db.prepare('SELECT stock FROM offers WHERE store_id=1 AND book_id=1').get().stock,5);
 assert.equal(db.prepare("SELECT delta FROM stock_movements WHERE item_id=(SELECT id FROM stock_items WHERE sku='LEG-1-1') ORDER BY id DESC LIMIT 1").get().delta,-2);
});
