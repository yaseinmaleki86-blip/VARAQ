'use strict';
const path=require('node:path');
const {verifyBackup}=require('./lib/backup-integrity');
const dir=process.argv[2];
if(!dir){console.error('Usage: node verify-backup.js "PATH_TO_BACKUP_FOLDER"');process.exit(2);}
try{const report=verifyBackup(path.resolve(dir));console.log('VERIFIED OK\n'+JSON.stringify(report,null,2));}
catch(error){console.error('VERIFICATION FAILED: '+error.message);process.exitCode=1;}
