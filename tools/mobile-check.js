'use strict';
/* VARAQ 7.9 — dependency-free, non-destructive HTTP/structure QA for core mobile paths.
 * This is NOT a browser screenshot test: it checks actual served HTML, styles and assets.
 */
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const paths=['/','/books','/book/book-001','/book/book-001/read','/pdf-books','/choose-format','/books/compare'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function unusedPort(){
 const sock=net.createServer();return new Promise((resolve,reject)=>{
  sock.once('error',reject);sock.listen(0,'127.0.0.1',()=>{const port=sock.address().port;sock.close(()=>resolve(port));});
 });
}
async function run(){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-mobile-check-'));
 const port=await unusedPort(),base=`http://127.0.0.1:${port}`;
 const server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:base,DATA_DIR:dataDir,PUBLIC_READONLY:'1'},stdio:['ignore','ignore','pipe']});
 let stderr='';server.stderr.on('data',c=>{stderr=(stderr+String(c)).slice(-2000);});
 const checks=[];const add=(name,passed,detail='')=>checks.push({name,passed:Boolean(passed),detail});
 const request=async uri=>fetch(base+uri,{signal:AbortSignal.timeout(8000)});
 try{
  let ready=false;
  for(let i=0;i<80;i++){try{const r=await request('/health');if(r.ok){ready=true;break;}}catch{}await sleep(100);}
  if(!ready)throw Error(`Server did not start: ${stderr}`);
  const health=await(await request('/health')).json();
  add('version-and-payment-gate',health.version==='8.6.0'&&health.payment_enabled===false,JSON.stringify({version:health.version,payment_enabled:health.payment_enabled}));
  for(const uri of paths){
   const res=await request(uri),html=await res.text();
   add(`public-page:${uri}`,res.status===200&&/<html lang="fa" dir="rtl">/.test(html)&&/name="viewport"/.test(html)&&/id="main-content" tabindex="-1"/.test(html),`HTTP ${res.status}; HTML ${Buffer.byteLength(html)} bytes`);
   if(uri==='/books'){
    add('search-and-compare',/catalog-filter-toggle/.test(html)&&/v71-compare-form/.test(html)&&/v75-card-formats/.test(html));
   }
   if(uri==='/')add('mobile-navigation-and-skip',/mobile-bottom-nav/.test(html)&&/class="skip-link"/.test(html));
  }
  const styles=fs.readFileSync(path.join(root,'public/style.css'),'utf8');
  add('mobile-touch-controls',/VARAQ 7\.6/.test(styles)&&/\.save-book-card\{width:44px;height:44px/.test(styles)&&/\.v68-card-actions a\{min-height:44px/.test(styles));
  add('mobile-320-359-layout-rules',/@media\(max-width:359px\)/.test(styles)&&/@media\(max-width:740px\)/.test(styles));
  add('narrow-single-column-cards', /VARAQ 7\.7/.test(styles)&&/@media\(max-width:430px\)/.test(styles)&&/\.book-card-v48\{display:grid;grid-template-columns:104px/.test(styles));
  for(const kind of ['concept-thumb','concept-art']){
   const r=await request(`/${kind}/book-001.webp?v=86`),data=Buffer.from(await r.arrayBuffer());
   add(`asset:${kind}`,r.ok&&r.headers.get('content-type')==='image/webp'&&data.length>100&&data.length<150000,`HTTP ${r.status}, ${data.length} bytes`);
  }
  const privatePdf=await request('/pdf-delivery/'+ 'X'.repeat(43));
  add('private-download-unavailable',privatePdf.status===404,`HTTP ${privatePdf.status}`);
  const passed=checks.every(x=>x.passed);
  const result={version:'8.6.0',kind:'HTTP and markup smoke; not browser or real-device verification',passed,checks};
  if(process.argv.includes('--json'))console.log(JSON.stringify(result,null,2));
  else{
   console.log('VARAQ 8.2 — MOBILE HTTP QA (no real device / layout metrics)');
   for(const item of checks)console.log(`${item.passed?'PASS':'FAIL'}  ${item.name}${item.detail?' — '+item.detail:''}`);
   console.log(`${checks.filter(c=>c.passed).length}/${checks.length} checks passed.`);
  }
  if(!passed)process.exitCode=1;
 }finally{
  if(server.exitCode===null){server.kill('SIGINT');await Promise.race([new Promise(r=>server.once('exit',r)),sleep(1600)]);if(server.exitCode===null)server.kill('SIGKILL');}
  fs.rmSync(dataDir,{recursive:true,force:true});
 }
}
run().catch(e=>{console.error('MOBILE_QA_FAILED:',e.message);process.exitCode=1;});
