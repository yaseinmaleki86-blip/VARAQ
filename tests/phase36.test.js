'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
async function server(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq36-'));const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,VARAQ_CURATED_SEED:'1',PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let log='';await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('server timeout '+log)),16000);child.stdout.on('data',d=>{log+=d;if(log.includes('PAYMENT: DISABLED')){clearTimeout(timer);ok();}});child.stderr.on('data',d=>log+=d);child.on('exit',x=>{clearTimeout(timer);fail(Error('exited '+x+' '+log));});});
 t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode?r():child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});return {base:`http://127.0.0.1:${port}`,dir};
}
test('3.6: public routes render mobile navigation, truthful product pricing, removable filters and safe text', async t=>{
 const s=await server(t);const health=await(await fetch(s.base+'/health')).json();assert.deepEqual(health,{ok:true,version:'8.6.0',payment_enabled:false,orders_mode:'demo_only'});
 const home=await(await fetch(s.base+'/')).text();assert.match(home,/class="mobile-nav-backdrop"/);assert.match(home,/class="mobile-nav-close"/);assert.match(home,/aria-expanded="false"/);assert.match(home,/class="mobile-bottom-nav"/);assert.match(home,/class="card-price"/);
 const list=await(await fetch(s.base+'/books?q=%3Cscript%3E&sort=newest&category=%DA%A9%D9%88%D8%AF%DA%A9%20%D9%88%20%D9%86%D9%88%D8%AC%D9%88%D8%A7%D9%86')).text();
 assert.match(list,/catalog-active-filters/);assert.match(list,/aria-label="حذف مرتب‌سازی: تازه‌ترین"/);assert.match(list,/id="book-results"/);assert.doesNotMatch(list,/<script>(?:alert|\s*<)/);
 const clean=await(await fetch(s.base+'/books?sort=title')).text();assert.match(clean,/href="\/books" aria-label="حذف مرتب‌سازی: الفبایی"/);
 const asset=await fetch(s.base+'/assets/app.js');assert.equal(asset.status,200);assert.match(await asset.text(),/Escape/);
 const db=new DatabaseSync(path.join(s.dir,'varaq.sqlite'));assert.equal(db.prepare('SELECT count(*) n FROM books').get().n,1000);assert.equal(db.prepare('SELECT count(*) n FROM edition_sources').get().n,128);db.close();
});
test('3.6: mobile sidebar stays keyboard-accessible and no account-less admin content leaks',async t=>{
 const s=await server(t);let r=await fetch(s.base+'/panel',{redirect:'manual'});assert.equal(r.status,303);
 r=await fetch(s.base+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'admin',password:'ad123456789'}),redirect:'manual'});assert.equal(r.status,303);
 const cookie=r.headers.get('set-cookie').split(';')[0];r=await fetch(s.base+'/panel/account',{headers:{cookie}});const admin=await r.text();
 assert.match(admin,/class="panel-nav-toggle"/);assert.match(admin,/class="panel-side-links"/);assert.match(admin,/aria-controls="panel-section-links"/);
 assert.match(admin,/aria-current="page"/);
 assert.match(admin,/name="csrf"/);
});
