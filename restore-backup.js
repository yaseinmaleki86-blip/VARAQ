'use strict';
// Non-destructive recovery: ONLY to a new, empty target path. Never touches existing storage.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {verifyBackup}=require('./lib/backup-integrity');
const [sourceArg,targetArg]=process.argv.slice(2);
if(!sourceArg||!targetArg){console.error('Usage: node restore-backup.js "BACKUP_FOLDER" "NEW_EMPTY_STORAGE_FOLDER"');process.exit(2);}
const source=path.resolve(sourceArg),target=path.resolve(targetArg);
try{
 const verified=verifyBackup(source);
 if(target===source||target.startsWith(source+path.sep)||fs.existsSync(target))throw Error('مسیر مقصد باید جدید و غیرموجود باشد؛ بازنویسی داده‌های قبلی مجاز نیست.');
 fs.mkdirSync(path.dirname(target),{recursive:true});
 const stage=target+'.restore-'+crypto.randomBytes(6).toString('hex');
 try{
  fs.mkdirSync(stage,{recursive:false,mode:0o700});
  fs.copyFileSync(path.join(source,'varaq.sqlite'),path.join(stage,'varaq.sqlite'));
  for(const dir of ['covers','store-documents','banners','digital-pdfs'])if(fs.existsSync(path.join(source,dir)))fs.cpSync(path.join(source,dir),path.join(stage,dir),{recursive:true});
  // Independently re-check copied bytes before exposing restored data.
  fs.copyFileSync(path.join(source,'manifest.json'),path.join(stage,'manifest.json'));
  verifyBackup(stage);
  fs.writeFileSync(path.join(stage,'RESTORE_INFO.txt'),`Recovered from ${source} at ${new Date().toISOString()}\n`,{mode:0o600});
  fs.renameSync(stage,target);
  console.log('RESTORE VERIFIED: '+target+'\nFiles: '+verified.fileCount+'\nStart the website with DATA_DIR set to this path. The original storage was not changed.');
 }catch(err){fs.rmSync(stage,{recursive:true,force:true});throw err;}
}catch(err){console.error('RESTORE FAILED: '+err.message);process.exitCode=1;}
