'use strict';
const fs=require('node:fs'),path=require('node:path');const {DatabaseSync}=require('node:sqlite');const covers=require('./lib/cover-batch');
function argument(name){const i=process.argv.indexOf('--'+name);return i<0?'':process.argv[i+1]||'';}
function main(){
 const manifest=argument('manifest'),folder=argument('folder'),store=argument('storage')||process.env.DATA_DIR||path.join(__dirname,'storage');
 const apply=process.argv.includes('--apply');
 if(!manifest||!folder)throw Error('Usage: node import-covers.js --manifest PATH.csv --folder IMAGE_DIR [--storage DATA_DIR] [--apply]');
 const database=path.join(path.resolve(store),'varaq.sqlite');if(!fs.existsSync(database))throw Error('Database not found. Start the site once, then retry.');
 const rows=covers.parseManifest(fs.readFileSync(manifest,'utf8'));
 const db=new DatabaseSync(database);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');try{
  const result=covers.processRows(db,rows,folder,path.join(path.resolve(store),'covers'),apply);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(!apply)process.stdout.write('DRY RUN ONLY: No images saved. Review manifest and add --apply to commit.\n');
 }finally{db.close();}
}
try{main();}catch(e){process.stderr.write('ERROR: '+e.message+'\n');process.exitCode=1;}
