'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const net=require('node:net');
async function port(){return new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});s.once('error',reject);});}
async function fixture(t){const dir=mkdtempSync(join(tmpdir(),'varaq14-')),p=await port();const child=spawn(process.execPath,['server.js'],{cwd:join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(p),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});let output='';const ready=new Promise((resolve,reject)=>{const onData=b=>{output+=b.toString();if(output.includes('PAYMENT: DISABLED'))resolve();};child.stdout.on('data',onData);child.stderr.on('data',onData);child.once('exit',c=>reject(Error('exit '+c+' '+output)));setTimeout(()=>reject(Error('startup '+output)),10000).unref();});await ready;t.after(()=>{child.kill('SIGINT');rmSync(dir,{recursive:true,force:true});});return `http://127.0.0.1:${p}`;}
test('v1.4 storefront uses accessible saves and mobile navigation',async t=>{
 const url=await fixture(t);
 const r=await fetch(url+'/');const html=await r.text();assert.equal(r.status,200);
 assert.match(html,/id="site-main-nav"/);assert.match(html,/aria-expanded="false"/);
 assert.match(html,/class="save-book save-book-card"/);assert.match(html,/href="\/saved"/);
 assert.match(html,/۱۰۰۰ عنوان منتخب/);
 const js=await fetch(url+'/assets/app.js');const script=await js.text();assert.equal(js.status,200);assert.match(script,/varaq_reading_list_v1/);assert.match(script,/textContent/);
 const css=await fetch(url+'/assets/style.css');assert.equal(css.status,200);assert.match(await css.text(),/v14-saved-grid/);
});
test('v1.4 saved page remains private and does not request identity',async t=>{
 const url=await fixture(t);const r=await fetch(url+'/saved');const html=await r.text();
 assert.equal(r.status,200);assert.match(html,/کتاب‌های نشان‌شده من/);
 assert.match(html,/noindex,nofollow/);assert.match(r.headers.get('x-robots-tag')||'',/noindex/);
 assert.match(html,/id="saved-root"/);assert.doesNotMatch(html,/name="password"/);
});
test('v1.4 book detail save and payment lock are preserved',async t=>{
 const url=await fixture(t);const r=await fetch(url+'/book/book-001');const html=await r.text();
 assert.equal(r.status,200);assert.match(html,/detail-save/);assert.match(html,/data-book-slug="book-001"/);
 const health=await (await fetch(url+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
 assert.match(html,/پرداخت آنلاین تا آماده‌شدن درگاه فروشنده غیرفعال است/);
});
