'use strict';
const fs=require('node:fs');const path=require('node:path');
const {runtimeDir}=require('./lib/runtime-control');
const dataDir=path.resolve(process.env.DATA_DIR||path.join(__dirname,'storage'));
const root=runtimeDir(dataDir);
async function stopAll(){
 if(!fs.existsSync(root)){console.log('No VARAQ server control records found; nothing to stop.');return;}
 const files=fs.readdirSync(root).filter(f=>/^server-\d+\.json$/.test(f));
 if(!files.length){console.log('No registered VARAQ instances.');return;}
 let failures=0,stopped=0;
 for(const file of files){
  try{
   const full=path.join(root,file);
   if(!fs.lstatSync(full).isFile())throw Error('Not a regular control file');
   const item=JSON.parse(fs.readFileSync(full,'utf8'));
   if(item.app!=='VARAQ'||item.schema!==1||!Number.isSafeInteger(item.port)||item.port<1||item.port>65535||!/^[a-f0-9]{64}$/.test(item.token)||String(item.pid)!==file.slice(7,-5))throw Error('Invalid control record');
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),2500);
   try{
    const result=await fetch(`http://127.0.0.1:${item.port}/__varaq_local/stop`,{
      method:'POST',headers:{'x-varaq-stop-token':item.token},signal:controller.signal,redirect:'manual'});
    if(result.status!==200)throw Error(`Unexpected response ${result.status}`);
    stopped++;console.log(`Shutdown requested for VARAQ process ${item.pid} on port ${item.port}.`);
   }finally{clearTimeout(timer);}
  }catch(e){failures++;console.error(`Could not stop ${file}: ${e.message}. Control file kept; no other processes touched.`);}
 }
 console.log(`${stopped} stop requests accepted. ${failures} failed. Database, uploads and backups have not been deleted.`);
 if(failures)process.exitCode=1;
}
if(require.main===module)stopAll().catch(e=>{console.error(e);process.exitCode=1});
module.exports={stopAll};
