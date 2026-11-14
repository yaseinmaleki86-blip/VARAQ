'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync,readFileSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {tmpdir}=require('node:os');
const net=require('node:net');
const delay=ms=>new Promise(ok=>setTimeout(ok,ms));
async function server(t,publicMode=false){
 const root=resolve(__dirname,'..');const storage=mkdtempSync(join(tmpdir(),'varaq70-'));
 const port=await new Promise((ok,fail)=>{const socket=net.createServer();socket.listen(0,'127.0.0.1',()=>{const p=socket.address().port;socket.close(()=>ok(p));});socket.once('error',fail);});
 const origin='http://127.0.0.1:'+port;
 const env={...process.env,DATA_DIR:storage,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:publicMode?origin:''};
 const child=spawn(process.execPath,['server.js'],{cwd:root,env,stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',b=>errors+=String(b));
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGINT');await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(1400)]);}rmSync(storage,{recursive:true,force:true});});
 for(let i=0;i<115;i++){try{const response=await fetch(origin+'/health');if(response.ok)return {origin,storage};}catch{}await delay(85);}
 throw Error('Failed boot: '+errors);
}
test('7.0: general guide and contextual guide contain verified links and no paid purchase claim',async t=>{
 const {origin}=await server(t);
 const homepage=await(await fetch(origin+'/')).text();
 assert.match(homepage,/href="\/choose-format"/);
 const general=await(await fetch(origin+'/choose-format')).text();
 assert.match(general,/چاپی یا PDF/);
 assert.match(general,/نسخه چاپی/);
 assert.match(general,/نسخه PDF/);
 assert.match(general,/ثبت سفارش، پرداخت، ارسال و تحویل پولی/);
 assert.match(general,/name="robots" content="noindex,nofollow"/);
 const detail=await(await fetch(origin+'/book/book-001')).text();
 assert.match(detail,/href="\/choose-format\?book=book-001"/);
 const specific=await(await fetch(origin+'/choose-format?book=book-001')).text();
 assert.match(specific,/راهنمای نسخه برای این عنوان/);
 assert.match(specific,/\/book\/book-001#(?:edition-picker|book-offers)/);
 assert.match(specific,/\/book\/book-001\/read/);
 assert.doesNotMatch(specific,/action="\/(?:checkout|pay|pdf-delivery)/i);
 assert.equal((await(await fetch(origin+'/health')).json()).payment_enabled,false);
});
test('7.0: reject untrusted/unknown book selectors, preserve public readonly behavior',async t=>{
 const {origin}=await server(t,true);
 assert.equal((await fetch(origin+'/choose-format?book=../../secrets')).status,400);
 assert.equal((await fetch(origin+'/choose-format?book=book-9999')).status,404);
 const response=await fetch(origin+'/choose-format?book=book-001');assert.equal(response.status,200);
 const html=await response.text();
 assert.match(html,/ثبت سفارش، پرداخت، ارسال و تحویل پولی در این نسخه غیرفعال‌اند/);
 assert.match(html,/نام نویسنده هنوز مستند نشده است|راهنمای نسخه برای این عنوان/);
 assert.equal((await fetch(origin+'/pdf-delivery/'+'A'.repeat(43))).status,404);
 const home=await(await fetch(origin+'/')).text();assert.doesNotMatch(home,/href="\/cart"/);
});
test('7.0: mobile responsive / keyboard navigation styles are bundled and version bumped',()=>{
 const root=resolve(__dirname,'..');
 const css=readFileSync(join(root,'public/style.css'),'utf8');
 assert.match(css,/\.v70-format-grid\{display:grid/);
 assert.match(css,/@media\(max-width:740px\)/);
 assert.match(css,/\.v70-format-page a:focus-visible/);
 assert.match(css,/\.v70-format-grid\{grid-template-columns:1fr/);
 assert.equal(require('../lib/release-package').VERSION,'8.6.0');
});
