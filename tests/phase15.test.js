'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const net=require('node:net');
async function port(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{let p=s.address().port;s.close(()=>resolve(p));});});}
async function fixture(t){const data=mkdtempSync(join(tmpdir(),'varaq15-'));const p=await port();const proc=spawn(process.execPath,['server.js'],{cwd:join(__dirname,'..'),env:{...process.env,DATA_DIR:data,PORT:String(p),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});let text='';let timer;await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('startup timed out '+text)),10000);const acc=b=>{text+=b.toString();if(text.includes('PAYMENT: DISABLED')){clearTimeout(timer);resolve();}};proc.stdout.on('data',acc);proc.stderr.on('data',acc);proc.on('exit',code=>reject(new Error('premature exit '+code+' '+text)));});t.after(()=>{proc.kill();rmSync(data,{recursive:true,force:true});});return 'http://127.0.0.1:'+p;}
test('v1.5 Persian font applied to public site, detail, login, and panels with CSP',async t=>{
 const base=await fixture(t);
 for(const route of ['/','/books','/book/book-001','/login']){
  const res=await fetch(base+route);assert.equal(res.status,200,route);
  const html=await res.text();assert.match(html,/family=Vazirmatn/);assert.match(html,/fonts\.googleapis\.com/);
  assert.match(res.headers.get('content-security-policy'),/style-src 'self' https:\/\/fonts\.googleapis\.com/);
  assert.match(res.headers.get('content-security-policy'),/font-src 'self' https:\/\/fonts\.gstatic\.com/);
 }
 const style=await (await fetch(base+'/assets/style.css')).text();assert.match(style,/font-family:var\(--font-fa\)/);assert.match(style,/VARAQ v1\.5/);assert.match(style,/\.panel-main/);assert.match(style,/\.book-name/);
});
test('v1.5 font change preserves locked real payments',async t=>{
 const base=await fixture(t);
 const health=await (await fetch(base+'/health')).json();assert.deepEqual(health,{ok:true,version:'8.6.0',payment_enabled:false,orders_mode:'demo_only'});
 const cart=await (await fetch(base+'/cart')).text();assert.match(cart,/امکان ثبت سفارش پولی وجود ندارد/);
});
