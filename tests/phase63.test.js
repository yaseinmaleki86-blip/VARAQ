 'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const root=path.join(__dirname,'..');
const library=require('../data/generated_catalog_v63.json');
const motif=require('../data/illustration_manifest_v63.json');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq63-'));
 const server=net.createServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const port=server.address().port;await new Promise(ok=>server.close(ok));
 const proc=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});
 let errors='';proc.stderr.on('data',c=>errors+=c);
 t.after(async()=>{if(proc.exitCode===null){proc.kill();await Promise.race([new Promise(ok=>proc.once('exit',ok)),delay(1200)])}fs.rmSync(dir,{recursive:true,force:true})});
 const base='http://127.0.0.1:'+port;
 for(let i=0;i<120;i++){try{if((await fetch(base+'/health')).ok)return{base,dir}}catch{}await delay(50)}throw Error(errors);
}
test('6.3: 200 topical original illustrations, 200 retained draft summaries and helpful reading guides',()=>{
 assert.equal(library.length,200);assert.equal(motif.length,200);
 assert.equal(new Set(motif.map(x=>x.motif)).size>=20,true);
 for(let i=0;i<200;i++){
  const x=library[i],art=path.join(root,'public',x.image),bytes=fs.readFileSync(art);
  assert.equal(x.id,i+1);assert.equal(x.status,'generated_concept_not_publisher_cover');
  assert.ok(x.description.length>=80);assert.ok(x.reader_note.length>=45);
  assert.ok(Array.isArray(x.topics)&&x.topics.length>=2);
  assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WEBP');
 }
});
test('6.3: fresh cover assets, reading guide only for editorial drafts, legitimate payment still disabled',async t=>{
 const{base}=await start(t);
 const health=await(await fetch(base+'/health')).json();assert.equal(health.version,'8.6.0');assert.equal(health.payment_enabled,false);
 const list=await(await fetch(base+'/books')).text();assert.match(list,/concept-thumb\/book-001\.webp\?v=86/);
 const detail=await(await fetch(base+'/book/book-001')).text();assert.match(detail,/در یک نگاه/);assert.match(detail,/راهنمای مطالعه اولیه/);assert.match(detail,/روایتی درباره پیوند عشق/);
 assert.equal((await fetch(base+'/concept-art/book-001.webp?v=63')).status,200);
 const secret=await fetch(base+'/pdf-delivery/'+'1'.repeat(43));assert.equal(secret.status,404);
});
