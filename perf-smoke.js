'use strict';
// Small local GET smoke test. NOT a realistic load test or production SLA.
const {performance}=require('node:perf_hooks');
const urlArg=process.argv[2]||'http://127.0.0.1:3030';const url=new URL(urlArg);
if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)){
 console.error('Only local HTTP benchmark URLs are permitted');process.exit(2);
}
const pages=['/','/books','/books?q=کتاب','/authors','/educational','/health'];const count=60,concurrency=6;
(async()=>{
 const measures=[];let next=0,errors=[];const overall=performance.now();
 const runner=async()=>{while(next<count){const index=next++,path=pages[index%pages.length];const t=performance.now();try{const r=await fetch(url.origin+path,{signal:AbortSignal.timeout(7000)});await r.arrayBuffer();if(!r.ok)errors.push(path+' HTTP '+r.status);}catch(e){errors.push(path+': '+e.message);}measures.push(performance.now()-t);}};
 await Promise.all(Array.from({length:concurrency},runner));
 const seconds=(performance.now()-overall)/1000;measures.sort((a,b)=>a-b);const p=q=>Math.round(measures[Math.min(measures.length-1,Math.ceil(q*measures.length)-1)]);
 const summary={requests:count,concurrency,errors,elapsedSeconds:+seconds.toFixed(2),requestsPerSecond:+(count/seconds).toFixed(1),medianMs:p(.5),p95Ms:p(.95)};
 console.log('Local developer-only smoke benchmark:\n'+JSON.stringify(summary,null,2));if(errors.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
