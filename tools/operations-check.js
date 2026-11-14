'use strict';
/* VARAQ 7.8: isolated, non-destructive HTTP check of seller/order workflows.
   Uses a temporary SQLite database, never the user's installed storage.
   It does NOT verify real payment, shipment, a bank gateway, or legal rights.
*/
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const VERSION=require('../package.json').version;
const ROOT=path.resolve(__dirname,'..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){
 const s=net.createServer();return await new Promise((resolve,reject)=>{
  s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});
 });
}
async function run(){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-ops-check-'));
 const port=await freePort(),origin=`http://127.0.0.1:${port}`;
 const proc=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,DATA_DIR:dataDir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:'',VARAQ_CURATED_SEED:'1'},stdio:['ignore','ignore','pipe']});
 let stderr='';proc.stderr.on('data',b=>{stderr=(stderr+String(b)).slice(-3000);});
 const checks=[];const add=(key,ok,detail='')=>checks.push({key,ok:Boolean(ok),detail});
 const request=(url,opts={})=>fetch(origin+url,{redirect:'manual',signal:AbortSignal.timeout(6000),...opts});
 const get=(url,cookie)=>request(url,{headers:cookie?{cookie}:{}});
 const post=(url,body,cookie)=>request(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...(cookie?{cookie}:{})},body:new URLSearchParams(body)});
 const cookie=res=>res.headers.get('set-cookie')?.split(';')[0]||'';
 const csrf=async(url,c)=>{const h=await(await get(url,c)).text();return h.match(/name="csrf" value="([^"]+)"/)?.[1]||'';};
 let db;
 try{
  let ready=false;
  for(let i=0;i<160;i++){
   if(proc.exitCode!==null)break;
   try{const res=await get('/health');if(res.ok){ready=true;break;}}catch{}
   await sleep(75);
  }
  if(!ready)throw Error('Isolated VARAQ server failed to start: '+stderr);
  const h=await(await get('/health')).json();
  add('no-paid-orders',h.version===VERSION&&h.payment_enabled===false&&h.orders_mode==='demo_only');
  db=new DatabaseSync(path.join(dataDir,'varaq.sqlite'));
  db.prepare("INSERT INTO stores(name,slug,city,active) VALUES('فروشگاه دوم تست','second-qa','یزد',1)").run();
  const ids=db.prepare('SELECT id FROM stores ORDER BY id').all().map(x=>Number(x.id));
  const stmt=db.prepare(`INSERT INTO demo_orders(order_code,store_id,client_ref,customer_alias,city,sample_address,shipping_method,book_subtotal,payment_status,status)
    VALUES(?,?,?,'مشتری آزمایشی','یزد','آدرس نمونه','pickup',43000,'disabled','demo_new')`);
  stmt.run('DEMO-QA-ONE',ids[0],'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  stmt.run('DEMO-QA-TWO',ids[1],'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  const guest=await get('/panel/orders');add('orders-require-login',guest.status===303||guest.status===302,`HTTP ${guest.status}`);
  const guestExport=await get(`/panel/order-checklist.csv?store=${ids[0]}`);
  add('csv-requires-login',[302,303].includes(guestExport.status),`HTTP ${guestExport.status}`);
  let a=cookie(await post('/login',{username:'admin',password:'ad123456789'}));
  if(!a)throw Error('Temporary admin login failed');
  const token=await csrf('/panel/account',a);
  const changed=await post('/panel/account',{csrf:token,username:'admin',old_password:'ad123456789',new_password:'TemporaryQaPassword12345',confirm_password:'TemporaryQaPassword12345'},a);
  add('initial-password-change',changed.status===303,`HTTP ${changed.status}`);
  a=cookie(await post('/login',{username:'admin',password:'TemporaryQaPassword12345'}));
  if(!a)throw Error('Temporary changed admin login failed');
  const ownerOrders=await get(`/panel/orders?store=${ids[0]}`,a),ownerHtml=await ownerOrders.text();
  add('owner-mobile-order-cards',ownerOrders.status===200&&ownerHtml.includes('v78-orders-cards')&&ownerHtml.includes('DEMO-QA-ONE')&&!ownerHtml.includes('DEMO-QA-TWO'));
  const adminStores=await get('/panel/stores',a);add('owner-store-panel',adminStores.status===200&&(await adminStores.text()).includes('فروشگاه دوم تست'));
  const ownerCSRF=await csrf('/panel/users',a);
  const created=await post('/panel/user',{csrf:ownerCSRF,username:'opsTester',password:'TemporarySellerPass12345',store_id:String(ids[0])},a);
  add('create-isolated-seller',created.status===303,`HTTP ${created.status}`);
  const seller=cookie(await post('/login',{username:'opsTester',password:'TemporarySellerPass12345'}));
  if(!seller)throw Error('Temporary seller login failed');
  const own=await get(`/panel/orders?store=${ids[0]}`,seller),ownHtml=await own.text();
  add('seller-own-order-visible',own.status===200&&ownHtml.includes('DEMO-QA-ONE')&&!ownHtml.includes('DEMO-QA-TWO'));
  const other=await get(`/panel/orders?store=${ids[1]}`,seller);
  const otherHtml=await other.text();
  add('seller-other-store-isolated',other.status===200&&otherHtml.includes('DEMO-QA-ONE')&&!otherHtml.includes('DEMO-QA-TWO'),`HTTP ${other.status}; forced tenant scope`);
  const otherExport=await get(`/panel/order-checklist.csv?store=${ids[1]}`,seller);
  add('seller-cross-store-export-blocked',otherExport.status===403,`HTTP ${otherExport.status}`);
  const ownExport=await get(`/panel/order-checklist.csv?store=${ids[0]}`,seller);
  add('seller-own-export-scoped',ownExport.status===200&&(await ownExport.text()).includes('DEMO-QA-ONE'));
  const pdf=await get('/pdf-delivery/'+'X'.repeat(43));add('private-pdf-locked',pdf.status===404,`HTTP ${pdf.status}`);
  const inv=db.prepare("SELECT COUNT(*) n FROM demo_orders WHERE payment_status <> 'disabled'").get();
  add('demo-transactions-not-paid',inv.n===0);
  const passed=checks.every(c=>c.ok);
  return {version:VERSION,passed,kind:'isolated seller/order HTTP QA; no live browser, real payment or shipping',checks};
 }finally{
  db?.close();
  if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(r=>proc.once('exit',r)),sleep(1400)]);if(proc.exitCode===null)proc.kill('SIGKILL');}
  fs.rmSync(dataDir,{recursive:true,force:true});
 }
}
if(require.main===module){run().then(result=>{
 if(process.argv.includes('--json'))console.log(JSON.stringify(result,null,2));
 else{console.log(`VARAQ ${result.version} — isolated seller/orders QA`);for(const c of result.checks)console.log(`${c.ok?'PASS':'FAIL'} ${c.key} ${c.detail||''}`);console.log(`${result.checks.filter(c=>c.ok).length}/${result.checks.length} passed. No customer data was changed.`);}
 if(!result.passed)process.exitCode=1;
}).catch(e=>{console.error('OPERATIONS QA FAILED:',e.stack||e.message);process.exitCode=1;});}
module.exports={run};
