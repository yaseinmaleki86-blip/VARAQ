'use strict';
// VARAQ 7.9: non-destructive local launcher guard.
// Never opens another application on a reused port and never changes data.
const net=require('node:net');
const {setTimeout:sleep}=require('node:timers/promises');
const VERSION=require('../package.json').version;
function settings(env=process.env){
 const raw=String(env.PORT||'3030');
 if(!/^\d{1,5}$/.test(raw)||Number(raw)<1||Number(raw)>65535)throw Error('PORT must be between 1 and 65535.');
 const host=String(env.HOST||'127.0.0.1');
 if(host!=='127.0.0.1')throw Error('Windows local launcher requires HOST=127.0.0.1. Remove a custom HOST setting or use a deployment script.');
 if(env.PUBLIC_URL)throw Error('START_WINDOWS.bat is for local development, not public deployment.');
 return {port:Number(raw),host,origin:`http://127.0.0.1:${Number(raw)}`};
}
async function available(port){
 const server=net.createServer();
 return await new Promise((resolve,reject)=>{
  server.once('error',e=>e.code==='EADDRINUSE'||e.code==='EACCES'?resolve(false):reject(e));
  server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));
 });
}
async function health(origin){
 try{
  const res=await fetch(origin+'/health',{signal:AbortSignal.timeout(650),redirect:'manual'});
  if(!res.ok||res.status!==200)return null;
  const data=await res.json();
  return data&&data.ok===true&&data.version===VERSION&&data.payment_enabled===false&&data.orders_mode==='demo_only'?data:null;
 }catch{return null;}
}
async function check(config){
 if(await available(config.port))return {ok:true,message:`Local port ${config.port} is free.`};
 const h=await health(config.origin);
 return {ok:false,message:h
   ?`VARAQ ${VERSION} already responds on port ${config.port}. Do not start a second server. Use STOP_ALL.bat only for your own installation.`
   :`Port ${config.port} is occupied by a process that cannot be verified as this VARAQ instance. No server will be started. Check PORT and other apps.`};
}
async function wait(config,{tries=120,interval=250}={}){
 for(let i=0;i<tries;i++){
  if(await health(config.origin))return {ok:true,message:`VARAQ ${VERSION} passed the health check at ${config.origin}.`};
  await sleep(interval);
 }
 return {ok:false,message:`VARAQ did not pass its health check on port ${config.port}. See the server console; browser was not opened.`};
}
async function main(){
 const action=process.argv[2];
 if(!['check','wait'].includes(action))throw Error('Usage: node tools/startup-guard.js check|wait');
 const result=action==='check'?await check(settings()):await wait(settings());
 (result.ok?console.log:console.error)(result.message);
 if(!result.ok)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error('START ERROR: '+e.message);process.exitCode=1;});
module.exports={settings,available,health,check,wait};
