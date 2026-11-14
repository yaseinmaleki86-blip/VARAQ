'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const net=require('node:net');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(t,extra={}){
 const root=path.resolve(__dirname,'..');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq75-'));
 const socket=net.createServer();const port=await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',()=>{const reserved=socket.address().port;socket.close(()=>resolve(reserved));});});
 // The listening socket is closed before the chosen port is reused.
 const base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:base,DATA_DIR:dir,...extra},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',v=>err+=String(v));
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGINT');await Promise.race([new Promise(done=>child.once('exit',done)),wait(1200)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<100;i++){try{let r=await fetch(base+'/health');if(r.ok)return base;}catch{}await wait(90);}
 throw new Error('Server failed: '+err);
}
test('7.5 home has real links to print, topic and digital browsing',async t=>{
 const base=await start(t);const html=await(await fetch(base+'/')).text();
 assert.match(html,/v75-start-grid/);assert.match(html,/href="\/books" class="v75-start-option"/);
 assert.match(html,/href="\/themes" class="v75-start-option"/);
 assert.match(html,/href="\/pdf-books" class="v75-start-option"/);
 assert.equal((await(await fetch(base+'/health')).json()).payment_enabled,false);
});
test('7.5 book cards link directly to their own format guide, not paid checkout',async t=>{
 const base=await start(t);const html=await(await fetch(base+'/books')).text();
 assert.match(html,/v75-catalog-shortcuts/);assert.match(html,/v75-card-formats/);
 const match=html.match(/href="(\/choose-format\?book=[^"&]+)" class="v75-card-formats"/);
 assert.ok(match);const response=await fetch(base+match[1]);assert.equal(response.status,200);
 const detail=await response.text();assert.match(detail,/PDF/);assert.doesNotMatch(detail,/پرداخت موفق/);
});
test('7.5 public read-only mode does not create a payment or open private PDF files',async t=>{
 const base=await start(t,{PUBLIC_READONLY:'1'});const home=await(await fetch(base+'/')).text();
 assert.match(home,/v75-start-grid/);assert.doesNotMatch(home,/<a href="\/cart" class="simple-btn"/);
 assert.equal((await fetch(base+'/pdf-delivery/'+'X'.repeat(43))).status,404);
 assert.equal((await(await fetch(base+'/health')).json()).payment_enabled,false);
});
test('7.5 CSS touch targets and PDF feature are included without replacing private download rules',()=>{
 const root=path.resolve(__dirname,'..');const css=fs.readFileSync(path.join(root,'public/style.css'),'utf8');
 const pdf=fs.readFileSync(path.join(root,'lib/pdf-ui.js'),'utf8');
 assert.match(css,/\.v75-start-grid/);assert.match(css,/@media\(max-width:480px\)/);
 assert.match(css,/\.v75-card-formats/);assert.match(pdf,/v75-format-compare/);assert.match(pdf,/مقایسه چاپی و PDF/);
 assert.match(pdf,/فروش آنلاین این فایل هنوز فعال نشده است/);
});
