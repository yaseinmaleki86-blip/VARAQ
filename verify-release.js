'use strict';
const path=require('node:path');
const pkg=require('./lib/release-package');
const root=__dirname;
try{
 const report=pkg.verify(root);
 if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
 else{
  console.log('VARAQ '+report.version+' — source file integrity:',report.passed?'PASS':'FAIL');
  console.log('Checked '+report.verifiedFiles+' bundled files; unexpected files: '+report.unexpectedFiles.length);
  for(const e of report.errors)console.error('ERROR: '+e);
  if(report.unexpectedFiles.length)console.log('NOTE: Additional files (not auto-deleted): '+report.unexpectedFiles.join(', '));
  console.log('SHA-256 is not a digital signature. It does not verify the distributor or licensing.');
 }
 if(!report.passed)process.exitCode=1;
}catch(e){console.error('RELEASE VERIFICATION FAILED: '+e.message);process.exitCode=1;}
