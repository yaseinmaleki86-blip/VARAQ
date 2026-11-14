'use strict';
const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const packageTools=require('./lib/release-package');const rehearsal=require('./lib/recovery-rehearsal');
const audit=require('./lib/release-audit');const smoke=require('./lib/public-smoke');const {decide}=require('./lib/release-decision');
const argv=process.argv.slice(2),option=name=>{const i=argv.indexOf(name);return i<0?null:argv[i+1]};
(async()=>{
 const dataDir=path.resolve(process.env.DATA_DIR||path.join(__dirname,'storage'));
 const source=packageTools.verify(__dirname);
 const backup=rehearsal.rehearse({dataDir});
 let db=null,appAudit;
 try{
  const f=path.join(dataDir,'varaq.sqlite');
  if(fs.existsSync(f))db=new DatabaseSync(f,{readOnly:true});
  appAudit=audit.assess({db,dataDir});
 }finally{db?.close();}
 let live=null;
 if(option('--url'))live=await smoke.run({url:option('--url'),indexing:argv.includes('--expect-indexed')});
 const result=decide({source,backup,audit:appAudit,smoke:live});
 if(option('--out')){
  const dest=path.resolve(option('--out'));
  // Never place the evidence in public assets, and never overwrite an earlier report.
  const forbidden=[path.resolve(__dirname,'public'),path.resolve(dataDir,'digital-pdfs')];
  if(forbidden.some(x=>dest===x||dest.startsWith(x+path.sep)))throw Error('Do not write release evidence into publicly reachable or protected media storage.');
  fs.writeFileSync(dest,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 console.log(JSON.stringify(result,null,2));
 process.exitCode=result.technicalPreviewCandidate?0:1;
})().catch(e=>{console.error('RELEASE DECISION ERROR: '+e.message);process.exitCode=1;});
