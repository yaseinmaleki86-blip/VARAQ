'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'..');
const events=require('../lib/operational-events');
const diagnostic=require('../lib/operational-status');

test('7.9 incident references never disclose credentials, query strings or error details',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-incident-'));
 t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const secret='secret-customer-token-123',id=events.recordError(dir,{method:'POST',url:'/pdf-delivery/'+secret+'?password='+secret,status:500,error:new TypeError('api-key:'+secret)});
 assert.match(id,/^[0-9a-f]{12}$/);
 const file=path.join(events.logDir(dir),'incidents.jsonl');
 const raw=fs.readFileSync(file,'utf8');
 assert.equal(raw.includes(secret),false);
 assert.equal(raw.includes('api-key'),false);
 const parsed=JSON.parse(raw.trim());
 assert.equal(parsed.group,'/pdf-delivery');assert.equal(parsed.kind,'TypeError');
 assert.equal(parsed.method,'POST');assert.equal(parsed.status,500);
 if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o077,0);
 const count=events.inspect(dir);
 assert.equal(count.last24Hours,1);assert.equal(count.invalidLines,0);
});

test('7.9 rejects symlink incident logs without redirecting data',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-linklog-'));
 t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const privateDir=events.logDir(dir);fs.mkdirSync(privateDir);
 const external=path.join(dir,'external.txt');fs.writeFileSync(external,'do not change');
 fs.symlinkSync(external,path.join(privateDir,'incidents.jsonl'));
 events.recordError(dir,{url:'/panel?secret=should-not-appear',error:new Error('private')});
 assert.equal(fs.readFileSync(external,'utf8'),'do not change');
});

test('7.9 operational diagnostics read SQLite without creating files or enabling sales',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-opstatus-'));
 t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const storage=path.join(dir,'storage');
 let report=diagnostic.run({root,dataDir:storage,env:{}});
 assert.equal(report.technicalChecksPassed,false);
 assert.equal(fs.existsSync(storage),false,'diagnostic must not initialize storage');
 fs.mkdirSync(storage);
 const file=path.join(storage,'varaq.sqlite'),db=new DatabaseSync(file);
 db.exec('CREATE TABLE books(id INTEGER PRIMARY KEY, title TEXT NOT NULL);INSERT INTO books VALUES(1,\'Example\');');db.close();
 const before=fs.statSync(file).mtimeMs;
 report=diagnostic.run({root,dataDir:storage,env:{}});
 assert.equal(report.version,'8.6.0');
 assert.equal(report.technicalChecksPassed,true,JSON.stringify(report.checks));
 assert.equal(report.paymentEnabled,false);assert.equal(report.publicSalesAllowed,false);
 assert.equal(report.checks.find(x=>x.code==='sqlite_readonly').ok,true);
 assert.equal(fs.statSync(file).mtimeMs,before);
 const json=JSON.parse(execFileSync(process.execPath,['tools/ops-status.js','--json'],{cwd:root,env:{...process.env,DATA_DIR:storage},encoding:'utf8'}));
 assert.equal(json.version,'8.6.0');assert.equal(json.technicalChecksPassed,true);
 assert.equal(json.publicSalesAllowed,false);
});

test('7.9 public diagnostics verify HTTPS and binding but do not certify commercial sales',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq-pubstatus-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const r=diagnostic.run({root,dataDir:dir,env:{PUBLIC_URL:'http://example.com/path?secret=abc',HOST:'0.0.0.0'}});
 assert.equal(r.mode,'public_preview');
 assert.equal(r.checks.find(x=>x.code==='public_https').ok,false);
 assert.equal(r.checks.find(x=>x.code==='loopback_binding').ok,false);
 assert.equal(JSON.stringify(r).includes('secret=abc'),false);
 assert.equal(r.publicSalesAllowed,false);
});

test('7.9 ships local Windows/Linux operations status and retains other launch tools',()=>{
 for(const file of ['OPERATIONS_STATUS_WINDOWS.bat','OPERATIONS_STATUS_LINUX_MAC.sh','OPERATIONS_QA_WINDOWS.bat','START_WINDOWS.bat','STOP_ALL.bat','BACKUP_WINDOWS.bat']){
  assert.ok(fs.statSync(path.join(root,file)).isFile(),file);
 }
 const app=fs.readFileSync(path.join(root,'server.js'),'utf8');
 assert.match(app,/operationalEvents\.recordError/);
 assert.doesNotMatch(app,/console\.error\('\[request error\]',e\)/);
});


test('7.9 startup rejects DATA_DIR located within publicly served assets',()=>{
 const {spawnSync}=require('node:child_process');
 const exposed=path.join(root,'public','unsafe-storage-should-not-be-created');
 const p=spawnSync(process.execPath,['server.js'],{cwd:root,env:{...process.env,DATA_DIR:exposed,PORT:'0'},encoding:'utf8',timeout:9000});
 assert.notEqual(p.status,0);
 assert.match(p.stderr,/DATA_DIR must be outside the public assets directory/);
 assert.equal(fs.existsSync(exposed),false);
});
