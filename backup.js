'use strict';
// Safe consistent database snapshot + protected media + SHA-256 manifest.
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');
const {makeManifest,verifyBackup}=require('./lib/backup-integrity');
const data=path.resolve(process.env.DATA_DIR||path.join(__dirname,'storage'));
const dbFile=path.join(data,'varaq.sqlite');
if(!fs.existsSync(dbFile)){console.error('ابتدا سایت را اجرا کنید تا پایگاه داده ساخته شود.');process.exit(1);}
const base=path.join(data,'backups');fs.mkdirSync(base,{recursive:true,mode:0o700});
const name='varaq-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid;
const target=path.join(base,name);fs.mkdirSync(target,{mode:0o700});
const db=new DatabaseSync(dbFile,{readOnly:true});
(async()=>{
 try{
  await backup(db,path.join(target,'varaq.sqlite'));db.close();
  // Normalize snapshot to a single SQLite file, ensuring any WAL is checkpointed before checksums.
  const checkDb=new DatabaseSync(path.join(target,'varaq.sqlite'));
  try{checkDb.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');}finally{checkDb.close();}
  for(const folder of ['covers','store-documents','banners','digital-pdfs']){
   const source=path.join(data,folder);
   if(fs.existsSync(source))fs.cpSync(source,path.join(target,folder),{recursive:true,force:false,errorOnExist:true});
  }
  makeManifest(target);
  const checked=verifyBackup(target);
  fs.writeFileSync(path.join(target,'BACKUP_INFO.txt'),
   'VARAQ v1.2 verified backup. To recover: stop the server, run node restore-backup.js "BACKUP_DIR" "NEW_STORAGE_DIR"; set DATA_DIR to the new directory. Do not overwrite your original storage.\n');
  console.log('VERIFIED BACKUP: '+target+'\nFiles: '+checked.fileCount+'; SQLite integrity: OK');
 }catch(err){
  try{db.close();}catch{}
  fs.rmSync(target,{recursive:true,force:true});
  console.error('BACKUP FAILED: '+err.message);process.exitCode=1;
 }
})();
