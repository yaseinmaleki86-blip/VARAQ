'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {DatabaseSync}=require('node:sqlite');
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});s.on('error',reject);});}
async function run(storage){const port=await freePort();const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:storage,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let output='';let done,fail;const ready=new Promise((resolve,reject)=>{done=resolve;fail=reject});const collect=c=>{output+=c.toString();if(output.includes('PAYMENT: DISABLED'))done();};proc.stdout.on('data',collect);proc.stderr.on('data',collect);proc.on('exit',c=>fail(Error('server exit '+c+': '+output)));const timeout=setTimeout(()=>fail(Error('timeout '+output)),15000);await ready.finally(()=>clearTimeout(timeout));return {base:`http://127.0.0.1:${port}`,proc};}
const csrf=html=>html.match(/name="csrf" value="([^"]+)"/)?.[1];
const cookie=res=>res.headers.get('set-cookie')?.split(';')[0];
async function get(s,p,c=''){return fetch(s.base+p,{headers:{cookie:c},redirect:'manual'});}
async function post(s,p,fields,c=''){return fetch(s.base+p,{method:'POST',headers:{cookie:c,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields),redirect:'manual'});}
async function form(s,p,formData,c=''){return fetch(s.base+p,{method:'POST',headers:{cookie:c},body:formData,redirect:'manual'});}
async function login(s,username,password){const response=await post(s,'/login',{username,password});return {status:response.status,c:cookie(response),location:response.headers.get('location')};}
async function token(s,p,c){return csrf(await (await get(s,p,c)).text());}
async function accountChange(s,c,old,newPassword){const t=await token(s,'/panel/account',c);const r=await post(s,'/panel/account',{csrf:t,username:'admin',old_password:old,new_password:newPassword,confirm_password:newPassword},c);assert.equal(r.status,303);}
const png=fs.readFileSync(path.join(__dirname,'fixtures','test_cover.png'));
function docForm(t,store,kind='business_license'){const form=new FormData();form.set('csrf',t);form.set('store_id',String(store));form.set('kind',kind);form.set('consent','1');form.set('document',new Blob([png],{type:'image/png'}),'business-license.png');return form;}
test('seller onboarding, private documents, manual compliance review and activation',async t=>{
 const storage=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-phase5-'));
 const s=await run(storage);t.after(()=>{s.proc.kill('SIGINT');fs.rmSync(storage,{recursive:true,force:true});});
 let a=await login(s,'admin','ad123456789');assert.equal(a.location,'/panel/account');
 await accountChange(s,a.c,'ad123456789','newSecureAdmin123456');a=await login(s,'admin','newSecureAdmin123456');
 const ac=await token(s,'/panel/stores',a.c);
 let r=await post(s,'/panel/store',{csrf:ac,name:'کتاب‌فروشی دوم',slug:'store-two',city:'یزد',active:'1'},a.c);assert.equal(r.status,303);
 const db=new DatabaseSync(path.join(storage,'varaq.sqlite'));
 const storeId=db.prepare("SELECT id FROM stores WHERE slug='store-two'").get().id;
 assert.equal(db.prepare('SELECT active FROM stores WHERE id=?').get(storeId).active,0,'unapproved new store remains hidden');
 r=await get(s,`/store/${storeId}`);assert.equal(r.status,404);
 r=await post(s,'/panel/store-review',{csrf:ac,store_id:String(storeId),status:'approved',verified_manually:'1'},a.c);assert.equal(r.status,400,'no license => no approval');
 r=await post(s,'/panel/user',{csrf:ac,username:'shopManager2',password:'InitialPassword123',store_id:String(storeId)},a.c);assert.equal(r.status,303);
 let m=await login(s,'shopManager2','InitialPassword123');assert.equal(m.status,303);
 const mc=await token(s,'/panel/store-docs',m.c);
 r=await post(s,'/panel/store-review',{csrf:mc,store_id:String(storeId),status:'approved',verified_manually:'1'},m.c);assert.equal(r.status,403,'seller cannot approve self');
 r=await form(s,'/panel/store-doc-upload',docForm(mc,storeId),m.c);assert.equal(r.status,303);
 const doc=db.prepare('SELECT * FROM store_documents WHERE store_id=?').get(storeId);assert.equal(doc.kind,'business_license');
 r=await get(s,`/panel/store-doc-download/${doc.id}`);assert.notEqual(r.status,200,'private download unauthenticated');
 r=await get(s,`/panel/store-doc-download/${doc.id}`,m.c);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');
 assert.equal(Buffer.from(await r.arrayBuffer()).equals(png),true);
 r=await post(s,'/panel/store-submit',{csrf:mc,store_id:String(storeId)},m.c);assert.equal(r.status,303);
 assert.equal(db.prepare('SELECT review_status FROM stores WHERE id=?').get(storeId).review_status,'submitted');
 r=await post(s,'/panel/store-review',{csrf:ac,store_id:String(storeId),status:'approved'},a.c);assert.equal(r.status,400,'manual verification flag required');
 r=await post(s,'/panel/store-review',{csrf:ac,store_id:String(storeId),status:'approved',verified_manually:'1'},a.c);assert.equal(r.status,303);
 assert.equal(db.prepare('SELECT review_status FROM stores WHERE id=?').get(storeId).review_status,'approved');
 r=await post(s,'/panel/store',{csrf:ac,id:String(storeId),name:'کتاب‌فروشی دوم',slug:'store-two',city:'یزد',active:'1'},a.c);assert.equal(r.status,303);
 r=await get(s,`/store/${storeId}`);assert.equal(r.status,200);
 assert.equal(db.prepare('SELECT active FROM stores WHERE id=?').get(storeId).active,1);
 r=await post(s,'/panel/store-review',{csrf:ac,store_id:String(storeId),status:'rejected',review_note:'مدرک فعلاً معتبر نیست'},a.c);assert.equal(r.status,303);
 assert.equal(db.prepare('SELECT active FROM stores WHERE id=?').get(storeId).active,0);
 r=await get(s,'/health');assert.deepEqual(await r.json(),{ok:true,version:'8.6.0',payment_enabled:false,orders_mode:'demo_only'});
 db.close();
});
test('employee permissions are limited by store; disabling revokes sessions',async t=>{
 const storage=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-staff5-'));const s=await run(storage);t.after(()=>{s.proc.kill('SIGINT');fs.rmSync(storage,{recursive:true,force:true});});
 let a=await login(s,'admin','ad123456789');await accountChange(s,a.c,'ad123456789','strongNewPass444555');a=await login(s,'admin','strongNewPass444555');
 const ac=await token(s,'/panel/users',a.c);
 assert.equal((await post(s,'/panel/user',{csrf:ac,username:'manager1',password:'safeManagerPass123',store_id:'1'},a.c)).status,303);
 assert.equal((await post(s,'/panel/store',{csrf:ac,name:'دوم',slug:'another',city:'یزد'},a.c)).status,303);
 assert.equal((await post(s,'/panel/user',{csrf:ac,username:'manager2',password:'safeManagerPass456',store_id:'2'},a.c)).status,303);
 const m1=await login(s,'manager1','safeManagerPass123');const m2=await login(s,'manager2','safeManagerPass456');
 const c1=await token(s,'/panel/staff',m1.c),c2=await token(s,'/panel/staff',m2.c);
 let r=await post(s,'/panel/staff',{csrf:c1,username:'inventory1',password:'tempInventory123',permission:'inventory'},m1.c);assert.equal(r.status,303);
 r=await post(s,'/panel/staff',{csrf:c1,username:'reader1',password:'tempReadOnly123',permission:'viewer'},m1.c);assert.equal(r.status,303);
 let i=await login(s,'inventory1','tempInventory123');assert.equal(i.location,'/panel/account');
 let ic=await token(s,'/panel/account',i.c);r=await post(s,'/panel/account',{csrf:ic,username:'inventory1',old_password:'tempInventory123',new_password:'newInventoryPass123',confirm_password:'newInventoryPass123'},i.c);assert.equal(r.status,303);
 i=await login(s,'inventory1','newInventoryPass123');ic=await token(s,'/panel/inventory',i.c);
 r=await post(s,'/panel/offer',{csrf:ic,book_id:'1',store_id:'1',price:'123000',stock:'5',active:'1'},i.c);assert.equal(r.status,303);
 r=await post(s,'/panel/offer',{csrf:ic,book_id:'1',store_id:'2',price:'1',stock:'2',active:'1'},i.c);assert.equal(r.status,403);
 r=await get(s,'/panel/staff',i.c);assert.equal(r.status,403);
 r=await get(s,'/panel/store-docs',i.c);assert.equal(r.status,403);
 let v=await login(s,'reader1','tempReadOnly123');const vc=await token(s,'/panel/account',v.c);r=await post(s,'/panel/account',{csrf:vc,username:'reader1',old_password:'tempReadOnly123',new_password:'newReadOnlyPass456',confirm_password:'newReadOnlyPass456'},v.c);assert.equal(r.status,303);
 v=await login(s,'reader1','newReadOnlyPass456');const vt=await token(s,'/panel/inventory',v.c);
 r=await post(s,'/panel/offer',{csrf:vt,book_id:'1',store_id:'1',price:'500000',stock:'7',active:'1'},v.c);assert.equal(r.status,403);
 r=await post(s,'/panel/staff-status',{csrf:c2,id:'4',enabled:'0'},m2.c);assert.equal(r.status,403,'other store cannot disable staff');
 const db=new DatabaseSync(path.join(storage,'varaq.sqlite'));
 const userId=db.prepare("SELECT id FROM users WHERE username='inventory1'").get().id;
 r=await post(s,'/panel/staff-status',{csrf:c1,id:String(userId),enabled:'0'},m1.c);assert.equal(r.status,303);
 r=await get(s,'/panel/inventory',i.c);assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/login','disabled session no longer authenticated');
 r=await post(s,'/login',{username:'inventory1',password:'newInventoryPass123'});assert.equal(r.status,200);
 const docFormBad=new FormData();docFormBad.set('csrf',vt);docFormBad.set('store_id','1');docFormBad.set('kind','identity');docFormBad.set('consent','1');docFormBad.set('document',new Blob([png],{type:'image/png'}),'id.png');
 r=await form(s,'/panel/store-doc-upload',docFormBad,v.c);assert.equal(r.status,403);
 r=await get(s,'/health');assert.equal((await r.json()).payment_enabled,false);
 db.close();
});
