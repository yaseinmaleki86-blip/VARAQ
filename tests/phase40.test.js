'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const ROOT=path.join(__dirname,'..');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function serve(t,publicIndex=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq40-'));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const base=`http://127.0.0.1:${port}`;
 const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,VARAQ_CURATED_SEED:'1',PUBLIC_URL:base};
 delete env.VARAQ_PUBLIC_INDEX;delete env.VARAQ_LEGAL_REVIEWED;delete env.VARAQ_MEDIA_RIGHTS_REVIEWED;delete env.VARAQ_BROWSER_QA_APPROVED;
 if(publicIndex)Object.assign(env,{VARAQ_PUBLIC_INDEX:'1',VARAQ_LEGAL_REVIEWED:'1',VARAQ_MEDIA_RIGHTS_REVIEWED:'1',VARAQ_BROWSER_QA_APPROVED:'1'});
 let logs='';const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 let ready=false;for(let i=0;i<140;i++){if(child.exitCode!==null)throw Error('failed server '+logs);try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await pause(50);}
 if(!ready)throw Error('not ready '+logs);
 t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode?r():child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});
 return {base,dir};
}
test('4.0 public preview blocks all demo order writes, receipts, and shopping CTAs',async t=>{
 const {base,dir}=await serve(t);
 const health=await(await fetch(base+'/health')).json();assert.deepEqual(health,{ok:true,version:'8.6.0',payment_enabled:false,orders_mode:'public_readonly'});
 let r=await fetch(base+'/book/book-001');assert.equal(r.status,200);let html=await r.text();assert.match(html,/نسخه اطلاعاتی ورق/);assert.doesNotMatch(html,/class="cta add-cart"/);
 r=await fetch(base+'/cart');assert.equal(r.status,200);html=await r.text();assert.match(html,/ثبت سفارش.*فعال نیست/);assert.doesNotMatch(html,/data-demo-token/);
 r=await fetch(base+'/demo-order',{method:'POST',body:'test=1'});assert.equal(r.status,403);
 r=await fetch(base+'/demo-order/preview',{method:'POST',body:'test=1'});assert.equal(r.status,403);
 r=await fetch(base+'/demo-order/received?code=DEMO-000001&key='+('f'.repeat(64)));assert.equal(r.status,404);
 r=await fetch(base+'/demo-order/track');assert.equal(r.status,404);
 const db=new DatabaseSync(path.join(dir,'varaq.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) n FROM demo_orders').get().n,0);}finally{db.close();}
});
test('4.0 indexing is opt-in; robots, sitemap and headers never leak unapproved site into search',async t=>{
 const {base}=await serve(t);
 let r=await fetch(base+'/');assert.match(r.headers.get('x-robots-tag'),/noindex/);assert.match(await r.text(),/content="noindex,nofollow"/);
 r=await fetch(base+'/robots.txt');assert.match(await r.text(),/Disallow: \/\n/);
 r=await fetch(base+'/sitemap.xml');assert.equal(r.status,404);
});
test('4.0 approved public index retains sourced-book SEO but not search results or private admin pages',async t=>{
 const {base}=await serve(t,true);
 let r=await fetch(base+'/');assert.equal(r.headers.get('x-robots-tag'),null);assert.doesNotMatch(await r.text(),/<meta name="robots" content="noindex,nofollow">/);
 r=await fetch(base+'/robots.txt');assert.match(await r.text(),/Sitemap:/);
 r=await fetch(base+'/sitemap.xml');assert.equal(r.status,200);assert.match(await r.text(),/\/book\/book-001/);
 r=await fetch(base+'/books?q=test');assert.match(await r.text(),/noindex,follow/);
 r=await fetch(base+'/login');assert.match(r.headers.get('x-robots-tag'),/noindex/);
 r=await fetch(base+'/demo-order',{method:'POST'});assert.equal(r.status,403);
});
