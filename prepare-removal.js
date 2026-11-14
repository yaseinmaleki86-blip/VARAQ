'use strict';
// Non-destructive prepare-for-removal: preserve storage OUTSIDE application folder.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {sqliteStatus}=require('./lib/backup-integrity');
const root=__dirname;
const src=path.resolve(process.env.DATA_DIR||path.join(root,'storage'));
const parent=path.resolve(process.env.VARAQ_REMOVAL_BACKUP_PARENT||path.dirname(root));
function rejectLinks(dir){if(fs.lstatSync(dir).isSymbolicLink())throw Error('Linked storage path; manual backup required');for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 const target=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Symlink in storage; manual backup required: '+entry.name);
 if(entry.isDirectory())rejectLinks(target);
 if(!entry.isDirectory()&&!entry.isFile())throw Error('Unsupported storage item: '+entry.name);
}}
function main(){
 if(!fs.existsSync(src)){console.log('No storage directory exists. Stop complete; remove the project folder manually if desired.');return;}
 if(parent===root||parent.startsWith(root+path.sep))throw Error('Backup destination must be OUTSIDE project folder.');
 if(!fs.existsSync(parent))throw Error('Backup parent does not exist: '+parent);
 rejectLinks(src);
 const dest=path.join(parent,'VARAQ_PRESERVED_STORAGE_'+new Date().toISOString().replace(/[:.]/g,'-')+'_'+crypto.randomBytes(3).toString('hex'));
 fs.cpSync(src,dest,{recursive:true,force:false,errorOnExist:true,dereference:false});
 try{if(fs.existsSync(path.join(src,'varaq.sqlite'))){
  const result=sqliteStatus(path.join(dest,'varaq.sqlite'));
  if(!result.ok)throw Error('Preserved SQLite failed integrity checks');
 }
 console.log('Preserved ALL storage OUTSIDE project folder at:\n'+dest);
 console.log('No files from the original project have been deleted. Review backup, then manually delete the project folder if you intend to uninstall.');
 }catch(e){console.error('Backup verification failed; original data left intact: '+e.message);process.exitCode=1;}
}
if(require.main===module){try{main()}catch(e){console.error(e.message);process.exitCode=1}}
module.exports={main};
