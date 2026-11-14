'use strict';
// Run against a live PUBLIC_URL read-only installation; does not mutate project data.
const smoke=require('./lib/public-smoke');
const args=process.argv.slice(2);
const arg=(key)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
(async()=>{
 const target=arg('--url')||process.env.RELEASE_SMOKE_URL||`http://127.0.0.1:${process.env.PORT||3030}`;
 const result=await smoke.run({url:target,indexing:args.includes('--expect-indexed')});
 if(args.includes('--json'))console.log(JSON.stringify(result,null,2));
 else{
  console.log(`VARAQ ${result.version} — live public HTTP smoke • ${result.origin}`);
  for(const c of result.checks)console.log(`[${c.ok?'OK':'FAIL'}] ${c.id} — ${c.detail}`);
  console.log(`\nRESULT: ${result.passed?'PASS for tested HTTP safety controls':'FAIL — NOT cleared for publication'}`);
  if(result.aborted)console.log('ABORTED: app not confirmed as public-readonly. No write probes were sent.');
  console.log('This is not a payment, legal-rights, actual-browser, TLS-certificate or load test.');
 }
 if(!result.passed)process.exitCode=1;
})().catch(e=>{console.error('SMOKE ERROR: '+e.message);process.exitCode=1;});
