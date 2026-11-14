'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function boot(t,readonly=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq57-'));
 const sock=net.createServer();await new Promise(ok=>sock.listen(0,'127.0.0.1',ok));const port=sock.address().port;await new Promise(ok=>sock.close(ok));
 const base='http://127.0.0.1:'+port;
 const vars={...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:'',VARAQ_CURATED_SEED:'1'};
 if(readonly){vars.PUBLIC_URL='https://books.example.org';vars.VARAQ_PUBLIC_READONLY='1';}
 const proc=spawn(process.execPath,['server.js'],{cwd:ROOT,env:vars,stdio:['ignore','pipe','pipe']});let errors='';proc.stderr.on('data',x=>errors+=x.toString());
 t.after(async()=>{if(proc.exitCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(ok=>proc.once('exit',ok)),sleep(1600)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<160;i++){try{if((await fetch(base+'/health')).ok)return {base,dir};}catch{}await sleep(50);}throw Error(errors);
}
test('5.7 filters retain GET semantics, query escaping, accessible mobile toggle and graceful zero-results',async t=>{
 const s=await boot(t);
 let r=await fetch(s.base+'/books');assert.equal(r.status,200);let h=await r.text();
 assert.match(h,/class="catalog-filter-toggle"/);
 assert.match(h,/aria-controls="catalog-filter-panel"/);
 assert.match(h,/data-active-filters="0"/);
 assert.match(h,/<form class="filterbar discovery-filters" action="\/books" method="GET">/);
 assert.match(h,/href="\/books\?page=2"/);
 r=await fetch(s.base+'/books?q=%3Ctest%3E&cover=missing');h=await r.text();
 assert.equal(r.status,200);assert.match(h,/data-active-filters="2"/);assert.match(h,/&lt;test&gt;/);assert.doesNotMatch(h,/<test>/);
 assert.match(h,/catalog-active-filters/);
 r=await fetch(s.base+'/books?q=zzzzzz_does_not_exist_57');h=await r.text();assert.equal(r.status,200);assert.match(h,/۰ عنوان پیدا شد/);
 const cssUrl=h.match(/href="(\/assets\/style\.[^"]+\.css)"/)?.[1];
 assert.ok(cssUrl);const css=await(await fetch(s.base+cssUrl)).text();
 assert.match(css,/catalog-filter-panel\.v57-enhanced\.v57-collapsed/);
 assert.match(css,/\.v57-detail-nav/);
});
test('5.7 book page has anchored sections and safe print checkout offer metadata',async t=>{
 const s=await boot(t);
 const first=await(await fetch(s.base+'/books')).text();const slug=first.match(/href="\/book\/(book-[a-z0-9-]+)"/)?.[1];assert.ok(slug);
 const response=await fetch(s.base+'/book/'+slug);assert.equal(response.status,200);
 const h=await response.text();assert.match(h,/aria-label="بخش‌های صفحه کتاب"/);assert.match(h,/href="#book-facts"/);assert.match(h,/id="book-facts"/);assert.match(h,/href="#book-offers"/);assert.match(h,/id="book-offers"/);
 const health=await(await fetch(s.base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
 const cart=await(await fetch(s.base+'/cart')).text();assert.match(cart,/class="v57-cart-links"/);assert.match(cart,/data-demo-token=/);
 assert.match(cart,/هیچ پولی دریافت نمی‌شود/);
 const scriptUrl=h.match(/src="(\/assets\/app\.[^"]+\.js)"/)?.[1];assert.ok(scriptUrl);
 const js=await(await fetch(s.base+scriptUrl)).text();assert.match(js,/VARAQ 5\.7/);assert.match(js,/v57-cart-book/);assert.match(js,/حداکثر ۱۵ عنوان و ۳۰ جلد/);
});
test('5.7 public mode still hides cart ordering and PDF download',async t=>{
 const s=await boot(t,true);
 const health=await(await fetch(s.base+'/health')).json();assert.equal(health.payment_enabled,false);assert.equal(health.orders_mode,'public_readonly');
 const cart=await(await fetch(s.base+'/cart')).text();assert.match(cart,/ثبت سفارش، پرداخت و ارسال در نسخه عمومی اولیه فعال نیست/);assert.doesNotMatch(cart,/data-demo-token=/);
 const pdf=await(await fetch(s.base+'/pdf-books')).text();assert.match(pdf,/پرداخت و تحویل غیرفعال/);
 const res=await fetch(s.base+'/demo-order/preview',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'store_id=1&items=[]'});assert.notEqual(res.status,200);
});
