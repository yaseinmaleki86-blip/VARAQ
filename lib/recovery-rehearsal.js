'use strict';
// Safe dry run: verify an existing backup, copy into OS temporary space, verify again, destroy temp.
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {verifyBackup}=require('./backup-integrity');
function newestVerifiedBackup(dataDir){
 const root=path.join(path.resolve(dataDir),'backups');
 if(!fs.existsSync(root))return null;
 const names=fs.readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory()&&!x.isSymbolicLink()).map(x=>x.name).sort().reverse();
 for(const n of names){const target=path.join(root,n);try{return {path:target,record:verifyBackup(target)}}catch{/* skip corrupt backups */}}
 return null;
}
function rehearse({dataDir,backupDir}={}){
 const candidate=backupDir?{path:path.resolve(backupDir)}:newestVerifiedBackup(dataDir);
 if(!candidate)return {passed:false,reason:'No verified backup found. Create and verify a new backup first.'};
 let workspace;
 try{
  const source=path.resolve(candidate.path),initial=verifyBackup(source);
  workspace=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-restore-rehearsal-'));
  const destination=path.join(workspace,'restored-storage');
  fs.mkdirSync(destination,{mode:0o700});
  for(const file of initial.fileCount?['varaq.sqlite','manifest.json']:[])fs.copyFileSync(path.join(source,file),path.join(destination,file));
  for(const dir of ['covers','store-documents','banners','digital-pdfs']){
   const orig=path.join(source,dir);if(fs.existsSync(orig))fs.cpSync(orig,path.join(destination,dir),{recursive:true,force:false,errorOnExist:true});
  }
  const restored=verifyBackup(destination);
  return {passed:restored.verified===true&&initial.fileCount===restored.fileCount,backupCreatedAt:initial.createdAt,verifiedFiles:restored.fileCount,originalUntouched:true};
 }catch(e){return {passed:false,reason:e.message};}
 finally{if(workspace)fs.rmSync(workspace,{recursive:true,force:true});}
}
module.exports={newestVerifiedBackup,rehearse};
