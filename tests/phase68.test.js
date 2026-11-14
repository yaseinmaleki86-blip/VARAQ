'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function live(t,publicMode=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq68-'));
 const probe=net.createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));
 const port=probe.address().port;await new Promise(ok=>probe.close(ok));
 const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:publicMode?base:''},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',data=>stderr+=String(data));
 t.after(async()=>{if(child.exitCode===null){child.kill();await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(1300)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let n=0;n<120;n++){try{if((await fetch(base+'/health')).ok)return{base};}catch{}await delay(65);}throw Error(stderr||'Server not ready');
}
test('6.8: book preview has separate prominent reading action and correct art status',async t=>{
 const {base}=await live(t);
 const resp=await fetch(base+'/books');assert.equal(resp.status,200);
 const page=await resp.text();
 assert.match(page,/v68-card-actions/);
 assert.match(page,/خواندن معرفی/);
 assert.match(page,/کتاب چاپی · معرفی/);
 assert.match(page,/طرح اختصاصی/);
 assert.equal((await(await fetch(base+'/health')).json()).payment_enabled,false);
});
test('6.8: reading room has accessible TOC, privacy-only reader UI, and no raw paid PDF',async t=>{
 const {base}=await live(t,true);
 const response=await fetch(base+'/book/book-001/read');assert.equal(response.status,200);
 const html=await response.text();
 for(const target of ['#reader-intro','#sample','#reader-check'])assert.ok(html.includes(target),target);
 for(const marker of ['data-reading-reset','data-reading-focus','data-reading-spacing','aria-valuenow="0"','data-reading-font="larger"'])assert.ok(html.includes(marker),marker);
 assert.match(html,/نمونه‌ای از متن اصلی کتاب با مجوز قابل‌انتشار فعلاً ثبت نشده/);
 assert.match(html,/name="robots" content="noindex,nofollow"/);
 assert.doesNotMatch(html,/https?:\/\/[^\"']*\.pdf/);
 const script=await(await fetch(base+'/assets/app.js')).text();
 assert.match(script,/varaq-reader-display-v68/);
 assert.doesNotMatch(script,/localStorage\.setItem\(['"]reading-history/);
 assert.equal((await fetch(base+'/pdf-delivery/'+'A'.repeat(43))).status,404);
});
test('6.8: digital storefront exposes removable filters and never claims live checkout',async t=>{
 const {base}=await live(t,true);
 const url=base+'/pdf-books?q='+encodeURIComponent('کتاب فارسی')+'&sort=price_asc';
 const response=await fetch(url);assert.equal(response.status,200);
 const html=await response.text();
 assert.match(html,/v68-pdf-chips/);
 assert.match(html,/حذف جست‌وجو:/);
 assert.match(html,/حذف قیمت: ارزان‌تر/);
 assert.match(html,/پرداخت و تحویل غیرفعال است/);
 assert.ok(html.includes('/pdf-books?sort=price_asc'));
 assert.equal((await(await fetch(base+'/health')).json()).orders_mode,'public_readonly');
 const style=await(await fetch(base+'/assets/style.css')).text();
 assert.match(style,/v68-reader-toc/);
 assert.match(style,/@media\(max-width:740px\)/);
});
