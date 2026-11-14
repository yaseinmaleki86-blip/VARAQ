'use strict';
// VARAQ 7.9: small, private, bounded incident metadata log. Never log URL queries,
// cookies, bodies, auth headers, secrets, customer records or exception messages.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const MAX_BYTES=256*1024;
const ALLOWED_METHODS=new Set(['GET','POST','HEAD','PUT','DELETE','OPTIONS','PATCH']);
function routeGroup(url){
 const pathname=String(url||'').split(/[?#]/,1)[0];
 if(/^\/pdf-delivery(?:\/|$)/.test(pathname))return '/pdf-delivery';
 if(/^\/demo-order(?:\/|$)/.test(pathname))return '/demo-order';
 if(/^\/panel(?:\/|$)/.test(pathname))return '/panel';
 if(/^\/media(?:\/|$)/.test(pathname))return '/media';
 if(/^\/book(?:\/|$)/.test(pathname))return '/book';
 if(/^\/books(?:\/|$)/.test(pathname))return '/books';
 if(/^\/health(?:\/|$)/.test(pathname))return '/health';
 return '/other';
}
function logDir(dataDir){return path.join(dataDir,'operations');}
function safeWrite(dataDir,row){
 try{
  const dir=logDir(dataDir);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,'incidents.jsonl');
  // Reject symlinks: a link here could redirect incident metadata outside storage.
  try{const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile())return false;
   if(st.size>=MAX_BYTES){const old=path.join(dir,'incidents.previous.jsonl');
    try{const os=fs.lstatSync(old);if(os.isSymbolicLink()||!os.isFile())return false;}catch(e){if(e.code!=='ENOENT')return false;}
    try{fs.unlinkSync(old);}catch(e){if(e.code!=='ENOENT')return false;}
    fs.renameSync(file,old);
   }
  }catch(e){if(e.code!=='ENOENT')return false;}
  fs.appendFileSync(file,JSON.stringify(row)+'\n',{encoding:'utf8',mode:0o600,flag:'a'});
  return true;
 }catch{return false;}
}
function recordError(dataDir,{method='GET',url='',status=500,error=null}={}){
 const id=crypto.randomBytes(6).toString('hex');
 const event={time:new Date().toISOString(),id,status:Number(status)===413?413:500,
  method:ALLOWED_METHODS.has(method)?method:'OTHER',group:routeGroup(url),
  // Only class, never exception message or stack (could contain credentials).
  kind:['TypeError','RangeError','SyntaxError'].includes(error?.name)?error.name:'ServerError'};
 safeWrite(dataDir,event);
 return id;
}
function inspect(dataDir,now=Date.now()){
 const results={last24Hours:0,invalidLines:0};
 for(const name of ['incidents.previous.jsonl','incidents.jsonl']){
  const file=path.join(logDir(dataDir),name);let value;
  try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())continue;
   if(st.size>MAX_BYTES+1024)continue;
   value=fs.readFileSync(file,'utf8');
  }catch{continue;}
  for(const line of value.split('\n')){
   if(!line)continue;
   try{const item=JSON.parse(line),date=Date.parse(item.time);
    if(!Number.isFinite(date))throw Error('invalid date');
    if(date<=now&&now-date<=86400000)results.last24Hours++;
   }catch{results.invalidLines++;}
  }
 }
 return results;
}
module.exports={recordError,inspect,routeGroup,logDir,MAX_BYTES};
