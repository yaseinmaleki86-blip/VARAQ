'use strict';
// Local read-only operational status. It does not initialize SQLite or authenticate
// publicly, does not print file paths/secrets, and never enables checkout.
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const errors=require('./operational-events');
const pkg=require('../package.json');
function run({root=path.resolve(__dirname,'..'),dataDir=path.join(root,'storage'),env=process.env,now=Date.now()}={}){
 const checks=[];
 const add=(code,ok,detail)=>checks.push({code,ok:!!ok,detail});
 const major=Number(process.versions.node.split('.')[0]);
 add('node_supported',major>=22&&Number(process.versions.node.split('.')[1])>= (major===22?13:0),`Node ${process.versions.node}`);
 let publicMode=false;
 try{
  if(env.PUBLIC_URL){const u=new URL(env.PUBLIC_URL);publicMode=true;
   add('public_https',u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/',
    'Public URL must be a clean HTTPS origin.');
   add('loopback_binding',['127.0.0.1','localhost','::1'].includes(env.HOST||'127.0.0.1'),
    'Public preview must bind behind a TLS reverse proxy on loopback.');
  }
 }catch{publicMode=true;add('public_https',false,'Invalid PUBLIC_URL');}
 // The live SQLite database and incident logs must never be placed in HTTP assets.
 const publicRoot=path.resolve(root,'public')+path.sep;
 let storagePrivate=false;
 try{const full=path.resolve(dataDir)+path.sep;
  storagePrivate=!full.startsWith(publicRoot)&&full!==path.resolve(root,'public')+path.sep;
  const real=fs.existsSync(dataDir)?fs.realpathSync(dataDir)+path.sep:full;
  storagePrivate=storagePrivate&&!real.startsWith(publicRoot);
 }catch{storagePrivate=false;}
 add('data_not_public',storagePrivate,'Storage must remain outside the public/ asset directory.');
 const dbFile=path.join(dataDir,'varaq.sqlite');
 let db=null;
 try{
  const dstat=fs.lstatSync(dataDir);
  add('data_folder',dstat.isDirectory()&&!dstat.isSymbolicLink(),'Persistent data folder is present and not a symlink.');
 }catch{add('data_folder',false,'Data folder does not exist. Launch the app locally to initialize it.');}
 try{
  const st=fs.lstatSync(dbFile);
  if(st.isSymbolicLink()||!st.isFile())throw Error('not regular file');
  db=new DatabaseSync(dbFile,{readOnly:true});
  const check=db.prepare('PRAGMA quick_check').get()?.quick_check;
  const badFk=db.prepare('PRAGMA foreign_key_check').all().length;
  add('sqlite_readonly',check==='ok'&&badFk===0,`SQLite quick_check=${check==='ok'?'ok':'failed'}; foreign key errors=${badFk}`);
  const count=db.prepare('SELECT count(*) n FROM books').get()?.n||0;
  add('catalog_exists',count>0,`${count} book records available.`);
 }catch{add('sqlite_readonly',false,'Database unavailable or unreadable in read-only mode.');}
 finally{db?.close();}
 for(const dir of ['concept-art','concept-thumb']){
  let count=0;
  try{count=fs.readdirSync(path.join(root,'public',dir)).filter(n=>/^book-\d{3,4}\.webp$/.test(n)&&fs.statSync(path.join(root,'public',dir,n)).size>0).length;}catch{}
  add(dir==='concept-art'?'full_art':'thumbnail_art',count>=1000,`${count}/1000 expected local concept images present.`);
 }
 const inc=errors.inspect(dataDir,now);
 add('incident_log',inc.invalidLines===0,`${inc.last24Hours} server incidents recorded in last 24 hours; ${inc.invalidLines} unreadable entries.`);
 // Never conflate technical checks with legal, gateway or device sign-off.
 const technical=checks.every(x=>x.ok);
 return {app:'VARAQ',version:pkg.version,mode:publicMode?'public_preview':'local_demo',generatedAt:new Date(now).toISOString(),
  technicalChecksPassed:technical,publicSalesAllowed:false,paymentEnabled:false,incidentCount24h:inc.last24Hours,checks,
  note:'Local technical diagnosis only. Not an HTTPS deployment, mobile-device, rights, payment, or production approval.'};
}
module.exports={run};
