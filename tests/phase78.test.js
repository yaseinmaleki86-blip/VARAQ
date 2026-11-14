'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const http=require('node:http');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const guard=require('../tools/startup-guard');
const VERSION=require('../package.json').version;

test('7.8 safe Windows launcher rejects invalid port/public mode and opens only after health',async t=>{
 assert.throws(()=>guard.settings({PORT:'3030&rm'}),/PORT/);
 assert.throws(()=>guard.settings({PORT:'70000'}),/PORT/);
 assert.throws(()=>guard.settings({HOST:'::1'}),/HOST/);
 assert.throws(()=>guard.settings({PORT:'3030',PUBLIC_URL:'https://example.org'}),/local development/);
 const server=http.createServer((req,res)=>{if(req.url==='/health'){
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,version:VERSION,payment_enabled:false,orders_mode:'demo_only'}));
 }else{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);}));
 const port=server.address().port,config={port,origin:`http://127.0.0.1:${port}`};
 const busy=await guard.check(config);assert.equal(busy.ok,false);assert.match(busy.message,/already responds/);
 const ready=await guard.wait(config,{tries:2,interval:10});assert.equal(ready.ok,true);
 assert.equal(await guard.available(port),false);
});

test('7.8 does not mistake a different web server for VARAQ',async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(404,{'connection':'close'});res.end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);}));
 const port=server.address().port,check=await guard.check({port,origin:`http://127.0.0.1:${port}`});
 assert.equal(check.ok,false);assert.match(check.message,/occupied/);
});

test('7.8 isolated seller/order HTTP workflow protects private data, payment and files',()=>{
 const out=execFileSync(process.execPath,['tools/operations-check.js','--json'],{cwd:root,encoding:'utf8',timeout:70000});
 const result=JSON.parse(out);
 assert.equal(result.version,VERSION);
 assert.equal(result.passed,true,JSON.stringify(result.checks.filter(x=>!x.ok)));
 assert.ok(result.checks.length>=12);
 for(const key of ['seller-other-store-isolated','seller-cross-store-export-blocked','owner-mobile-order-cards','private-pdf-locked','no-paid-orders']){
  assert.ok(result.checks.find(x=>x.key===key&&x.ok),key);
 }
});

test('7.8 responsive orders use accessible cards only on mobile, preserve desktop table and scripts',()=>{
 const source=fs.readFileSync(path.join(root,'server.js'),'utf8');
 const css=fs.readFileSync(path.join(root,'public/style.css'),'utf8');
 assert.match(source,/v78-orders-cards/);
 assert.match(source,/v78-orders-table/);
 assert.match(source,/aria-label="جزئیات سفارش نمونه/);
 assert.match(css,/\.v78-orders-cards\{display:none\}/);
 assert.match(css,/@media\(max-width:740px\)/);
 assert.match(css,/\.v78-orders-table\{display:none\}/);
 assert.match(css,/\.v78-open-order\{[^}]*min-height:44px/);
 for(const script of ['START_WINDOWS.bat','RUN_SERVER_WINDOWS.bat','STOP_ALL.bat','BACKUP_WINDOWS.bat','OPERATIONS_QA_WINDOWS.bat'])assert.ok(fs.existsSync(path.join(root,script)),script);
 const start=fs.readFileSync(path.join(root,'START_WINDOWS.bat'),'utf8');
 assert.match(start,/startup-guard\.js check/);
 assert.match(start,/startup-guard\.js wait/);
 assert.match(start,/start "" "http/);
});
