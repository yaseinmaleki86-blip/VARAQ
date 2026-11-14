'use strict';
// VARAQ 5.9 — non-destructive HTTP release smoke test. Never logs in, pays or downloads files.
const EXPECTED_VERSION='8.6.0';
function parseOrigin(raw){
 const u=new URL(String(raw));
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)
  throw Error('Use an HTTP(S) site origin with no path, credentials, query or fragment.');
 return u.origin;
}
function check(id,ok,detail){return {id,ok:Boolean(ok),detail:String(detail)};}
async function run({url,indexing=false,timeoutMs=5000,request=fetch}={}){
 const origin=parseOrigin(url),checks=[];
 const add=(id,ok,detail)=>checks.push(check(id,ok,detail));
 async function probe(path,method='GET',headers={}){
  try{
   const response=await request(origin+path,{method,redirect:'manual',headers,signal:AbortSignal.timeout(timeoutMs)});
   // Do not follow redirects: a 303 to /login must never leak credentials or visit other hosts.
   const text=method==='HEAD'?'':(await response.text()).slice(0,100000);
   return {status:response.status,headers:response.headers,text};
  }catch(e){return {status:0,headers:new Headers(),text:'',error:String(e.message||e)};}
 }
 const health=await probe('/health');let state={};
 try{state=JSON.parse(health.text);}catch{}
 add('health_public_readonly',health.status===200&&state.ok===true&&state.version===EXPECTED_VERSION&&state.orders_mode==='public_readonly'&&state.payment_enabled===false,
  `status=${health.status}, version=${state.version||'-'}, mode=${state.orders_mode||'-'}, payment=${state.payment_enabled}`);
 // Stop before any POST if the process is not positively known to be in public-readonly mode.
 if(!checks[0].ok)return {origin,version:EXPECTED_VERSION,indexingExpected:Boolean(indexing),passed:false,aborted:true,checks};
 const home=await probe('/');
 add('home_and_security_headers',home.status===200&&/nosniff/i.test(home.headers.get('x-content-type-options')||'')&&/default-src/.test(home.headers.get('content-security-policy')||'')&&home.headers.get('x-frame-options')==='DENY',`status=${home.status}; CSP=${Boolean(home.headers.get('content-security-policy'))}`);
 if(origin.startsWith('https://'))add('https_hsts',/max-age=/.test(home.headers.get('strict-transport-security')||''),'HTTPS must send Strict-Transport-Security');
 for(const [id,path] of [['printed_books','/books'],['digital_books','/pdf-books']]){
  const r=await probe(path);add(id,r.status===200,`GET ${path}: HTTP ${r.status}`);
 }
 const robots=await probe('/robots.txt');const sitemap=await probe('/sitemap.xml');
 if(indexing){
  add('indexing_opt_in',robots.status===200&&robots.text.includes('Sitemap:')&&sitemap.status===200&&!/noindex/i.test(home.headers.get('x-robots-tag')||''),`robots=${robots.status}, sitemap=${sitemap.status}, publicNoindex=${home.headers.get('x-robots-tag')||'none'}`);
 }else{
  add('indexing_locked',robots.status===200&&/Disallow:\s*\//.test(robots.text)&&sitemap.status===404&&/noindex/i.test(home.headers.get('x-robots-tag')||''),`robots=${robots.status}, sitemap=${sitemap.status}, noindex=${home.headers.get('x-robots-tag')||'none'}`);
 }
 for(const [id,path] of [['private_release_csv','/panel/release-readiness.csv'],['private_payment_ledger','/panel/payment-ledger.csv'],['private_panel','/panel']]){
  const r=await probe(path);add(id,r.status===303||r.status===403,`${path}: HTTP ${r.status} (no session)`);
 }
 const token='A'.repeat(43);
 const download=await probe('/pdf-delivery/'+token);
 add('unissued_pdf_token',download.status===404,`unknown PDF token: HTTP ${download.status}`);
 const head=await probe('/pdf-delivery/'+token,'HEAD');
 add('pdf_head_not_claimed',head.status===405,`PDF HEAD: HTTP ${head.status}`);
 for(const [id,path,status] of [['demo_checkout_disabled','/demo-order',403],['demo_quote_disabled','/demo-order/preview',403],['payment_verify_not_routed','/payments/verify',404]]){
  const r=await probe(path,'POST',{'Content-Type':'application/x-www-form-urlencoded'});
  add(id,r.status===status,`POST ${path}: HTTP ${r.status}`);
 }
 const receipt=await probe('/demo-order/track');
 add('demo_receipt_disabled',receipt.status===404,`GET /demo-order/track: HTTP ${receipt.status}`);
 const stop=await probe('/__varaq_local/stop');
 add('stop_control_unreachable',stop.status===404,`Unauthenticated stop control: HTTP ${stop.status}`);
 return {origin,version:EXPECTED_VERSION,indexingExpected:Boolean(indexing),passed:checks.every(x=>x.ok),aborted:false,checks};
}
module.exports={parseOrigin,run,EXPECTED_VERSION};
