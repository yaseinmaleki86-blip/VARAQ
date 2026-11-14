'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const ui=require('../lib/storefront-ui');
const ROOT=path.resolve(__dirname,'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const s=net.createServer();await new Promise(ok=>s.listen(0,'127.0.0.1',ok));const n=s.address().port;await new Promise(ok=>s.close(ok));return n;}
test('4.8 navigation keeps print/PDF destinations and accessible current state',()=>{
 for(const selected of ['print','digital','home']){
  const html=ui.formatNavigation(selected);
  assert.match(html,/aria-label="انتخاب نوع کتاب"/);
  assert.match(html,/href="\/books"/);
  assert.match(html,/href="\/pdf-books"/);
  assert.equal((html.match(/aria-current="page"/g)||[]).length,selected==='home'?0:1);
 }
 assert.match(ui.availabilityNotice(),/پرداخت آنلاین.*فعال نشده/);
});
test('4.8 SSR homepage, catalog, and PDF include responsive format switch and non-fictional cover status',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'varaq48-'));
 const port=await freePort(),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,VARAQ_CURATED_SEED:'1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',v=>error+=v);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(ok=>child.once('exit',ok)),sleep(1500)]);}fs.rmSync(data,{recursive:true,force:true});});
 let ok=false;for(let i=0;i<130;i++){try{const response=await fetch(base+'/health');if(response.ok){ok=true;break;}}catch{}await sleep(55);}
 assert.ok(ok,'server did not start: '+error);
 const health=await(await fetch(base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
 for(const endpoint of ['/','/books','/pdf-books']){
  const response=await fetch(base+endpoint);assert.equal(response.status,200,endpoint);
  const html=await response.text();assert.match(html,/class="format-navigation"/);assert.match(html,/href="\/pdf-books"/);assert.match(html,/href="\/books"/);
  assert.match(html,/viewport/);assert.match(html,/Varaq|ورق/);
 }
 const catalog=await(await fetch(base+'/books')).text();assert.match(catalog,/book-card-v48/);assert.match(catalog,/varaq-concept-cover/);assert.doesNotMatch(catalog,/جلد در حال تکمیل/);assert.match(catalog,/نویسنده در حال تکمیل/);assert.match(catalog,/v48-book-copy/);
 const home=await(await fetch(base+'/')).text();assert.match(home,/ویترین|چه نوع کتابی دنبال می‌کنی/);assert.match(home,/پرداخت آنلاین و تحویل سفارش واقعی هنوز فعال نشده‌اند/);
 const pdf=await(await fetch(base+'/pdf-books')).text();assert.match(pdf,/class="format-option is-active" href="\/pdf-books"/);assert.match(pdf,/پرداخت و تحویل غیرفعال/);
 const assetPath=home.match(/href="(\/assets\/style\.[^"]+\.css)"/)?.[1];assert.ok(assetPath);
 const assetResp=await fetch(base+assetPath);assert.equal(assetResp.status,200);const stylesheet=await assetResp.text();assert.match(stylesheet,/VARAQ 4.8/);
});
