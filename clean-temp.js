'use strict';
// Deliberately narrow allowlist. No recursive deletion of storage or app source.
const fs=require('node:fs');const path=require('node:path');
const {runtimeDir}=require('./lib/runtime-control');
const dataDir=path.resolve(process.env.DATA_DIR||path.join(__dirname,'storage'));
async function active(control){
 try{
  const response=await fetch(`http://127.0.0.1:${control.port}/health`,{signal:AbortSignal.timeout(1100)});
  const result=await response.json();return response.ok&&result.ok===true;
 }catch{return false;}
}
async function main(){
 const root=runtimeDir(dataDir);
 if(!fs.existsSync(root)){console.log('No temporary control files to clean.');return;}
 if(fs.lstatSync(root).isSymbolicLink())throw Error('Refusing symlinked runtime folder');
 let count=0;
 for(const filename of fs.readdirSync(root)){
  if(!/^server-\d+\.json$/.test(filename))continue;
  const full=path.join(root,filename);
  if(!fs.lstatSync(full).isFile())continue;
  let control;try{control=JSON.parse(fs.readFileSync(full,'utf8'));}catch{throw Error('Invalid runtime file; manual review required: '+filename);}
  if(control.app!=='VARAQ'||String(control.pid)!==filename.slice(7,-5)||!Number.isSafeInteger(control.port)||control.port<1||control.port>65535)throw Error('Invalid runtime file: '+filename);
  if(await active(control))throw Error('A server may still be active; use STOP_ALL first. No files deleted.');
  // Safety: do not destroy metadata if an unrelated process may own this PID.
  try{process.kill(control.pid,0);throw Error('PID is still running; manual review required');}
  catch(e){if(e.message==='PID is still running; manual review required'||e.code==='EPERM')throw e;if(e.code!=='ESRCH')throw e;}
  fs.unlinkSync(full);count++;
 }
 console.log(`Removed ${count} stale runtime record(s). No source files, books, images, database or backups were removed.`);
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={main};
