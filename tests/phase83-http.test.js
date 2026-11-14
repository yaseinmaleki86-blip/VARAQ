'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const net=require('node:net');
function port(){return new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});s.on('error',reject);});}
async function boot(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-v83-live-')),p=await port();
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,HOST:'127.0.0.1',PORT:String(p),DATA_DIR:dir,PUBLIC_URL:'',VARAQ_CURATED_SEED:'1'},stdio:['ignore','pipe','pipe']});
 t.after(()=>{proc.kill('SIGINT');setTimeout(()=>fs.rmSync(dir,{recursive:true,force:true}),300).unref();});
 let out='';await new Promise((resolve,reject)=>{
  const tm=setTimeout(()=>reject(Error('startup timeout '+out)),15000);
  const add=b=>{out+=b.toString();if(out.includes('PAYMENT: DISABLED')){clearTimeout(tm);resolve();}};
  proc.stdout.on('data',add);proc.stderr.on('data',add);proc.on('exit',n=>{clearTimeout(tm);reject(Error('server quit '+n+' '+out));});
 });
 return {url:`http://127.0.0.1:${p}`,dir};
}
async function get(s,uri,cookie=''){return fetch(s.url+uri,{headers:{cookie},redirect:'manual'});}
async function post(s,uri,form,cookie=''){return fetch(s.url+uri,{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),redirect:'manual'});}
function csrf(html){return html.match(/name="csrf" value="([^"]+)"/)?.[1];}
function cookie(res){return res.headers.get('set-cookie')?.split(';')[0];}
test('8.3 dashboard HTTP: role gate, CSRF, persisted evidence, CSV, and no sales',async t=>{
 const s=await boot(t);
 let r=await get(s,'/health');assert.equal((await r.json()).version,'8.6.0');
 r=await get(s,'/panel/bibliographic-review');assert.notEqual(r.status,200);
 r=await get(s,'/panel/bibliographic-review.csv');assert.notEqual(r.status,200);
 r=await post(s,'/login',{username:'admin',password:'ad123456789'});assert.equal(r.status,303);let c=cookie(r);
 r=await get(s,'/panel/account',c);const oldCsrf=csrf(await r.text());assert.ok(oldCsrf);
 r=await post(s,'/panel/account',{csrf:oldCsrf,username:'admin',old_password:'ad123456789',new_password:'newStrongPassword4321',confirm_password:'newStrongPassword4321'},c);assert.equal(r.status,303);
 r=await post(s,'/login',{username:'admin',password:'newStrongPassword4321'});assert.equal(r.status,303);c=cookie(r);
 r=await get(s,'/panel/bibliographic-review?mode=all',c);assert.equal(r.status,200);let html=await r.text();assert.match(html,/میز تأیید مستند شناسنامه/);assert.match(html,/۱٬۰۰۰/);
 r=await get(s,'/panel/bibliographic-review.csv?mode=all',c);assert.equal(r.status,200);const csv=await r.text();assert.equal(csv.trim().split('\r\n').length,1001);assert.match(r.headers.get('cache-control'),/no-store/);
 r=await get(s,'/panel/bibliographic-review?book=1',c);assert.equal(r.status,200);html=await r.text();const token=csrf(html);assert.ok(token);
 const signature=html.match(/name="fingerprint" value="([a-f0-9]{64})"/)?.[1];assert.ok(signature);
 r=await post(s,'/panel/bibliographic-review-save',{book_id:'1',status:'needs_correction',revision:'0',fingerprint:signature,source_url:'',notes:'برای بررسی نیاز به تطبیق شناسنامه چاپ داریم',csrf:'invalid'},c);assert.equal(r.status,403);
 r=await post(s,'/panel/bibliographic-review-save',{book_id:'1',status:'needs_correction',revision:'0',fingerprint:signature,source_url:'',notes:'برای بررسی نیاز به تطبیق شناسنامه چاپ داریم',csrf:token},c);assert.equal(r.status,303);
 r=await get(s,'/panel/bibliographic-review?book=1',c);html=await r.text();assert.match(html,/نیازمند اصلاح/);assert.match(html,/تاریخچه ثبت/);
 r=await get(s,'/books');assert.equal(r.status,200);
 r=await get(s,'/pdf-books');assert.equal(r.status,200);assert.match(await r.text(),/پرداخت و تحویل غیرفعال/);
});
