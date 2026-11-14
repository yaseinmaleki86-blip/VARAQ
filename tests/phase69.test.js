'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const sleep=t=>new Promise(ok=>setTimeout(ok,t));
async function live(t){
 const root=path.resolve(__dirname,'..');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq69-'));
 const socket=net.createServer();await new Promise(ok=>socket.listen(0,'127.0.0.1',ok));
 const port=socket.address().port;await new Promise(ok=>socket.close(ok));
 const origin='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',b=>err+=String(b));
 t.after(async()=>{if(child.exitCode===null){child.kill();await Promise.race([new Promise(ok=>child.once('exit',ok)),sleep(1500)]);}fs.rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<110;i++){try{const r=await fetch(origin+'/health');if(r.ok)return origin;}catch{}await sleep(80);}
 throw Error('Failed startup: '+err);
}
test('6.9: all 200 lightweight assets exist, are WebP, and save at least 45% total bytes',()=>{
 const dir=path.join(__dirname,'../public');
 let orig=0,small=0;
 for(let n=1;n<=200;n++){
  const name='book-'+String(n).padStart(3,'0')+'.webp';
  const full=fs.readFileSync(path.join(dir,'concept-art',name)),thumb=fs.readFileSync(path.join(dir,'concept-thumb',name));
  assert.equal(full.toString('ascii',0,4),'RIFF');assert.equal(thumb.toString('ascii',8,12),'WEBP');
  assert.ok(thumb.length<full.length,`thumbnail is not lighter for ${name}`);
  orig+=full.length;small+=thumb.length;
 }
 assert.ok(small/orig<0.55,`asset saving too small: ${small}/${orig}`);
});
test('6.9: home and catalogue load thumbnail URLs, detail loads full image with correct image labels',async t=>{
 const origin=await live(t);
 const home=await(await fetch(origin+'/')).text();
 assert.match(home,/\/concept-thumb\/book-001\.webp\?v=86/);
 assert.match(home,/fetchpriority="high"/);
 assert.match(home,/loading="lazy"/);
 const listing=await(await fetch(origin+'/books')).text();
 assert.match(listing,/\/concept-thumb\/book-001\.webp\?v=86/);
 assert.doesNotMatch(listing,/\/concept-art\/book-001\.webp\?v=86/);
 const detail=await(await fetch(origin+'/book/book-001')).text();
 assert.match(detail,/\/concept-art\/book-001\.webp\?v=86/);
 assert.match(detail,/جلد رسمی ناشر نیست/);
 assert.equal((await(await fetch(origin+'/health')).json()).payment_enabled,false);
});
test('6.9: versioned thumbnails send immutable content, safe ETag/304, HEAD and reject invalid IDs',async t=>{
 const origin=await live(t);
 const path='/concept-thumb/book-001.webp?v=86';
 const res=await fetch(origin+path);
 assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'image/webp');
 assert.match(res.headers.get('cache-control'),/immutable/);
 const etag=res.headers.get('etag');assert.match(etag,/^"[0-9a-f]{28}"$/);
 const bytes=(await res.arrayBuffer()).byteLength;
 assert.ok(bytes<20000,`thumbnail unexpectedly large: ${bytes}`);
 const other=await fetch(origin+path,{headers:{'If-None-Match':etag}});
 assert.equal(other.status,304);
 const head=await fetch(origin+path,{method:'HEAD'});
 assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),bytes);
 assert.equal((await head.arrayBuffer()).byteLength,0);
 const old=await fetch(origin+'/concept-thumb/book-001.webp');
 assert.doesNotMatch(old.headers.get('cache-control'),/immutable/);
 const full=await fetch(origin+'/concept-art/book-001.webp?v=86');
 assert.ok((await full.arrayBuffer()).byteLength>bytes);
 assert.equal((await fetch(origin+'/concept-thumb/book-9999.webp?v=86')).status,404);
 assert.equal((await fetch(origin+'/concept-thumb/book-001.jpg?v=86')).status,404);
 assert.equal((await fetch(origin+'/pdf-delivery/'+'A'.repeat(43))).status,404);
});
