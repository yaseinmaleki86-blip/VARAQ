'use strict';
// Local-only, token-authenticated graceful shutdown for this VARAQ instance.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
function runtimeDir(dataDir){return path.join(dataDir,'runtime');}
function register(dataDir,server){
 const folder=runtimeDir(dataDir);
 fs.mkdirSync(folder,{recursive:true,mode:0o700});
 const control={app:'VARAQ',schema:1,pid:process.pid,port:server.address().port,
  token:crypto.randomBytes(32).toString('hex'),startedAt:new Date().toISOString()};
 const file=path.join(folder,`server-${process.pid}.json`);
 // A restrictive local control token; never place in public/ or log it.
 fs.writeFileSync(file,JSON.stringify(control)+'\n',{mode:0o600,flag:'w'});
 return {...control,file};
}
function authorized(req,control){
 if(!control||req.method!=='POST')return false;
 const remote=String(req.socket.remoteAddress||'');
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote))return false;
 const candidate=String(req.headers['x-varaq-stop-token']||'');
 if(!/^[a-f0-9]{64}$/.test(candidate))return false;
 return crypto.timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(control.token,'hex'));
}
function clear(control){if(!control)return;try{
 const existing=JSON.parse(fs.readFileSync(control.file,'utf8'));
 if(existing.token===control.token&&existing.pid===control.pid)fs.unlinkSync(control.file);
 }catch(e){if(e.code!=='ENOENT')console.error('[runtime cleanup]',e.message);}}
module.exports={register,authorized,clear,runtimeDir};
