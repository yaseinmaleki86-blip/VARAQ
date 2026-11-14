'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'..');
const getPort=()=>new Promise((ok,fail)=>{const x=net.createServer().listen(0,'127.0.0.1',()=>{const n=x.address().port;x.close(()=>ok(n));});x.on('error',fail);});
async function start(t,storage){const port=await getPort(),proc=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:storage,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let logs='';let resolve,reject;const ready=new Promise((a,b)=>{resolve=a;reject=b});const onData=b=>{logs+=b.toString();if(logs.includes('PAYMENT: DISABLED'))resolve();};proc.stdout.on('data',onData);proc.stderr.on('data',onData);proc.once('exit',code=>reject(Error('server exited '+code+' '+logs)));const timeout=setTimeout(()=>reject(Error('timeout '+logs)),12000);await ready.finally(()=>clearTimeout(timeout));t.after(async()=>{proc.kill('SIGINT');await new Promise(done=>{if(proc.exitCode!==null||proc.signalCode)done();else proc.once('exit',done);});});return {base:`http://127.0.0.1:${port}`,proc};}
const ck=r=>r.headers.get('set-cookie')?.split(';')[0];
const get=(s,url,c)=>fetch(s.base+url,{redirect:'manual',headers:c?{cookie:c}:{}});
const post=(s,url,body,c)=>fetch(s.base+url,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',...(c?{cookie:c}:{})},body:new URLSearchParams(body)});
async function csrf(s,url,c){return(await(await get(s,url,c)).text()).match(/name="csrf" value="([^"]+)"/)?.[1];}
async function owner(s){let r=await post(s,'/login',{username:'admin',password:'ad123456789'}),cookie=ck(r);const tok=await csrf(s,'/panel/account',cookie);r=await post(s,'/panel/account',{csrf:tok,username:'admin',old_password:'ad123456789',new_password:'SecureReportOwner123',confirm_password:'SecureReportOwner123'},cookie);assert.equal(r.status,303);return ck(await post(s,'/login',{username:'admin',password:'SecureReportOwner123'}));}
function dbOpen(dir){return new DatabaseSync(path.join(dir,'varaq.sqlite'));}
function prepareStock(db,storeId=1,bookId=1,sku='REPORT-ABC',price=200001){let ed=db.prepare('SELECT id FROM editions WHERE book_id=?').get(bookId);if(!ed){db.prepare('INSERT INTO editions(book_id,label,publisher,verified) VALUES(?,?,?,1)').run(bookId,'چاپ تست','ناشر تست');ed=db.prepare('SELECT id FROM editions WHERE book_id=?').get(bookId);}return Number(db.prepare('INSERT INTO stock_items(store_id,book_id,edition_id,sku,price,quantity,active) VALUES(?,?,?,?,?,5,1)').run(storeId,bookId,ed.id,sku,price).lastInsertRowid);}
async function sampleOrder(s,stockId,ref,storeId=1,city='نمونه'){const html=await(await get(s,'/cart')).text(),token=html.match(/data-demo-token="([^"]+)"/)?.[1];assert.ok(token);return post(s,'/demo-order',{token,store_id:String(storeId),client_ref:ref,customer_alias:'مشتری آزمایشی',city,sample_address:'میدان فرضی',shipping_method:'pickup',demo_consent:'1',items:JSON.stringify([{id:stockId,qty:1}])});}
async function env(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-fin8-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const s=await start(t,dir);const db=dbOpen(dir);t.after(()=>db.close());return {s,db};}

test('phase8: commission percent validated, transactional immutable snapshot and cancellation excluded from projections',async t=>{
 const {s,db}=await env(t),o=await owner(s),csrfToken=await csrf(s,'/panel/commissions',o);
 let r=await post(s,'/panel/commission',{csrf:csrfToken,store_id:'1',rate:'5.25'},o);assert.equal(r.status,303);
 assert.equal(db.prepare('SELECT rate_bps FROM demo_commission_policies WHERE store_id=1').get().rate_bps,525);
 const item=prepareStock(db);
 r=await sampleOrder(s,item,'abce1234-1111-4444-aaaa-999999999991');assert.equal(r.status,303);
 const snap=db.prepare('SELECT * FROM demo_order_financial_snapshots WHERE order_id=1').get();assert.equal(snap.rate_bps,525);assert.equal(snap.commission_toman,10500);assert.equal(snap.seller_share_toman,189501);
 r=await post(s,'/panel/commission',{csrf:csrfToken,store_id:'1',rate:'10'},o);assert.equal(r.status,303);
 r=await sampleOrder(s,item,'abce1234-1111-4444-aaaa-999999999992');assert.equal(r.status,303);
 assert.equal(db.prepare('SELECT rate_bps FROM demo_order_financial_snapshots WHERE order_id=1').get().rate_bps,525);
 assert.equal(db.prepare('SELECT rate_bps FROM demo_order_financial_snapshots WHERE order_id=2').get().rate_bps,1000);
 assert.equal(db.prepare('SELECT count(*) n FROM demo_commission_changes').get().n,2);
 let page=await(await get(s,'/panel/reports',o)).text();assert.match(page,/گزارش کاملاً آزمایشی/);assert.match(page,/کارمزد فرضی YM/);
 const tok=await csrf(s,'/panel/orders?store=1&order=2',o);
 r=await post(s,'/panel/order-status',{csrf:tok,store_id:'1',order_id:'2',status:'demo_cancelled'},o);assert.equal(r.status,303);
 const reports=require('../lib/reports');const day=new Date().toISOString().slice(0,10);const data=reports.getReport(db,{storeId:1,from:day,to:day});
 assert.equal(data.metrics.count,2);assert.equal(data.metrics.cancelled,1);assert.equal(data.metrics.activeSubtotal,200001);assert.equal(data.metrics.projectedFee,10500);
 assert.equal((await(await get(s,'/health')).json()).payment_enabled,false);
});

test('phase8: owner all-store reports; sellers see only own reports; viewers cannot see reports or set fees',async t=>{
 const {s,db}=await env(t),o=await owner(s),tok=await csrf(s,'/panel/users',o);
 db.prepare("INSERT INTO stores(name,slug,active) VALUES('فروشگاه =SUM(1,2)','store-second',1)").run();
 let r=await post(s,'/panel/user',{csrf:tok,username:'sellerEight',password:'SellerPassEight123',store_id:'1'},o);assert.equal(r.status,303);
 r=await post(s,'/panel/user',{csrf:tok,username:'sellerOther8',password:'SellerOtherEight123',store_id:'2'},o);assert.equal(r.status,303);
 const item1=prepareStock(db,1,1,'REPORT-ONE',150000),item2=prepareStock(db,2,2,'REPORT-TWO',330000);
 await sampleOrder(s,item1,'abce1234-1111-4444-aaaa-888888888881',1);
 await sampleOrder(s,item2,'abce1234-1111-4444-aaaa-888888888882',2);
 let a=ck(await post(s,'/login',{username:'sellerEight',password:'SellerPassEight123'}));
 let b=ck(await post(s,'/login',{username:'sellerOther8',password:'SellerOtherEight123'}));
 let html=await(await get(s,'/panel/reports',a)).text();assert.match(html,/DEMO-000001/);assert.doesNotMatch(html,/DEMO-000002/);
 assert.equal((await get(s,'/panel/reports?store=2',a)).status,403);
 assert.equal((await get(s,'/panel/reports.csv?store=2',a)).status,403);
 assert.equal((await get(s,'/panel/commissions',a)).status,403);
 const sellerCsrf=await csrf(s,'/panel/reports',a);
 assert.equal((await post(s,'/panel/commission',{csrf:sellerCsrf,store_id:'1',rate:'12.00'},a)).status,403);
 html=await(await get(s,'/panel/reports',b)).text();assert.match(html,/DEMO-000002/);assert.doesNotMatch(html,/DEMO-000001/);
 html=await(await get(s,'/panel/reports',o)).text();assert.match(html,/DEMO-000001/);assert.match(html,/DEMO-000002/);
 const csv=await(await get(s,'/panel/reports.csv',o)).text();assert.match(csv,/DEMO-000002/);assert.match(csv,/فروشگاه =SUM/);
 db.prepare("UPDATE stores SET name='=SUM(1,2)' WHERE id=2").run();
 const formulaCsv=await(await get(s,'/panel/reports.csv',o)).text();assert.match(formulaCsv,/"'=SUM\(1,2\)"/,'CSV formula-leading values are escaped');
 // viewer account uses old seller permissions until first password change; explicitly set viewer for test
 db.prepare("INSERT INTO users(username,password_hash,role,store_id,staff_permission,must_change_password) SELECT 'viewEight',password_hash,'seller',store_id,'viewer',0 FROM users WHERE username='sellerEight'").run();
 let v=ck(await post(s,'/login',{username:'viewEight',password:'SellerPassEight123'}));
 assert.equal((await get(s,'/panel/reports',v)).status,403);
 assert.equal((await get(s,'/panel/reports.csv',v)).status,403);
});

test('phase8: invalid commission and time filters rejected; old orders remain unsnapshotted',async t=>{
 const {s,db}=await env(t),o=await owner(s),tok=await csrf(s,'/panel/commissions',o);
 for(const rate of ['20.01','-1','1e2','3.333','100','foo']){
  assert.equal((await post(s,'/panel/commission',{csrf:tok,store_id:'1',rate},o)).status,400,rate);
 }
 assert.equal(db.prepare('SELECT count(*) n FROM demo_commission_policies').get().n,0);
 const id=prepareStock(db);
 await sampleOrder(s,id,'abce1234-1111-4444-aaaa-777777777771');
 db.prepare('DELETE FROM demo_order_financial_snapshots WHERE order_id=1').run(); // resembles a 0.7 order migrated to v0.8
 assert.equal((await post(s,'/panel/commission',{csrf:tok,store_id:'1',rate:'6.00'},o)).status,303);
 assert.equal(db.prepare('SELECT count(*) n FROM demo_order_financial_snapshots WHERE order_id=1').get().n,0,'no retroactive snapshot');
 const html=await(await get(s,'/panel/reports',o)).text();assert.match(html,/فاقد عکس نرخ کارمزد/);
 assert.equal((await get(s,'/panel/reports.csv?from=2026-13-99&to=2026-10-31',o)).status,400);
 assert.equal((await get(s,'/panel/reports.csv?from=2025-01-01&to=2026-10-31',o)).status,400);
 assert.equal((await get(s,'/panel/reports.csv?status=paid',o)).status,400);
});
