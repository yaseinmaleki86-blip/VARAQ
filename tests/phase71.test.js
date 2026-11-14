'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const delay=ms=>new Promise(done=>setTimeout(done,ms));
async function start(t,publicMode=false){
 const root=path.resolve(__dirname,'..');
 const storage=fs.mkdtempSync(path.join(os.tmpdir(),'varaq71-'));
 const socket=net.createServer();
 const port=await new Promise((ok,fail)=>{socket.listen(0,'127.0.0.1',()=>{const n=socket.address().port;socket.close(()=>ok(n));});socket.on('error',fail);});
 // socket.address() becomes null on close on some runtimes; derive port before closing instead.
 assert.ok(port>0);
 const base=`http://127.0.0.1:${port}`;
 const env={...process.env,DATA_DIR:storage,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:publicMode?base:''};
 const child=spawn(process.execPath,['server.js'],{cwd:root,env,stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGINT');await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(1300)]);}fs.rmSync(storage,{recursive:true,force:true});});
 for(let i=0;i<90;i++){try{const res=await fetch(base+'/health');if(res.ok)return {base,storage};}catch{}await delay(80);}
 throw Error(errors||'Server startup failed');
}

test('7.1: catalog cards provide native comparison form; two/three selections reach live comparison',async t=>{
 const {base}=await start(t);
 const page=await(await fetch(base+'/books')).text();
 assert.match(page,/<form class="v71-compare-form" action="\/books\/compare" method="get"/);
 assert.match(page,/name="book" value="book-001"/);
 assert.match(page,/مقایسه سریع کتاب‌ها/);
 assert.match(page,/دو یا سه عنوان از همین صفحه انتخاب کن/);
 const names=[...page.matchAll(/name="book" value="(book-\d+)"/g)].map(x=>x[1]);
 assert.equal(names.length,24);
 assert.equal(new Set(names).size,24);
 const home=await(await fetch(base+'/')).text();assert.doesNotMatch(home,/class="v71-compare-choice"/);
 for(const n of [2,3]){
  const p=new URLSearchParams();for(const slug of names.slice(0,n))p.append('book',slug);
  const res=await fetch(base+'/books/compare?'+p);assert.equal(res.status,200);
  const html=await res.text();assert.match(html,/نتیجه مقایسه/);for(const slug of names.slice(0,n))assert.ok(html.includes('/book/'+slug));
 }
 const invalid=new URLSearchParams();for(const slug of names.slice(0,4))invalid.append('book',slug);
 assert.equal((await fetch(base+'/books/compare?'+invalid)).status,400);
 const health=await(await fetch(base+'/health')).json();assert.equal(health.payment_enabled,false);assert.equal(health.version,'8.6.0');
});

test('7.1: filtered catalog still provides matching selectable books, and public view is read-only',async t=>{
 const {base}=await start(t,true);
 const page=await(await fetch(base+'/books?sort=title&page=2')).text();
 assert.match(page,/class="v71-compare-form"/);
 assert.match(page,/page=3/);
 const names=[...page.matchAll(/name="book" value="(book-\d+)"/g)].map(x=>x[1]);assert.ok(names.length>1);
 const result=await fetch(base+'/books/compare?book='+names[0]+'&book='+names[1]);assert.equal(result.status,200);
 const comparison=await result.text();assert.match(comparison,/noindex,nofollow/);
 assert.match(comparison,/پرداخت غیرفعال/);
 const order=await fetch(base+'/demo-order/preview',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:''});assert.equal(order.status,403);
});

test('7.1: accessible mobile comparison logic, clear button, server limits and preserved images are bundled',()=>{
 const root=path.resolve(__dirname,'..');
 const js=fs.readFileSync(path.join(root,'public/app.js'),'utf8');
 const css=fs.readFileSync(path.join(root,'public/style.css'),'utf8');
 assert.match(js,/\.v71-compare-form/);assert.match(js,/selected\.length>=3/);assert.match(js,/for\(const box of boxes\)box\.addEventListener\('change',sync\)/);
 assert.match(css,/\.v71-compare-choice:focus-within/);assert.match(css,/@media\(max-width:740px\)/);
 assert.equal(require('../lib/release-package').VERSION,'8.6.0');
 const thumbnails=fs.readdirSync(path.join(root,'public/concept-thumb')).filter(x=>x.endsWith('.webp'));
 const artworks=fs.readdirSync(path.join(root,'public/concept-art')).filter(x=>x.endsWith('.webp'));
 assert.equal(thumbnails.length,1000);assert.equal(artworks.length,1000);
});
