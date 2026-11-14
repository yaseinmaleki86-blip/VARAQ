'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const pkg=require('../lib/release-package');
const backup=require('../lib/backup-integrity');
const recovery=require('../lib/recovery-rehearsal');
const {decide}=require('../lib/release-decision');
function tmp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'varaq60-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('6.0: release manifest verifies files and detects missing, tampered and unexpected code',t=>{
 const root=tmp(t);fs.mkdirSync(path.join(root,'lib'));fs.writeFileSync(path.join(root,'lib','source.js'),'const ok=1;');
 fs.writeFileSync(path.join(root,'README_FA.md'),'varaq');
 const manifest=pkg.create(root);fs.writeFileSync(path.join(root,pkg.MANIFEST),JSON.stringify(manifest));
 assert.equal(pkg.verify(root).passed,true);
 fs.writeFileSync(path.join(root,'lib','new.js'),'unexpected');
 assert.deepEqual(pkg.verify(root).unexpectedFiles,['lib/new.js']);
 assert.equal(pkg.verify(root).passed,false);
 fs.writeFileSync(path.join(root,'lib','source.js'),'const ok=0;');
 assert.equal(pkg.verify(root).passed,false);
 assert.match(pkg.verify(root).errors.join(','),/Altered/);
 fs.rmSync(path.join(root,'README_FA.md'));
 assert.match(pkg.verify(root).errors.join(','),/Missing/);
});
test('6.0: tampered manifest cannot access outside installation directory',t=>{
 const root=tmp(t);fs.writeFileSync(path.join(root,'test.js'),'fine');
 const m=pkg.create(root);m.files[0].path='../outside.txt';fs.writeFileSync(path.join(root,pkg.MANIFEST),JSON.stringify(m));
 const result=pkg.verify(root);
 assert.equal(result.passed,false);assert.match(result.errors.join(','),/Invalid manifest/);
});
test('6.0: restore rehearsal reads a real checked backup without touching original',t=>{
 const root=tmp(t),data=path.join(root,'storage'),snap=path.join(data,'backups','bk1');
 fs.mkdirSync(snap,{recursive:true});
 const db=new DatabaseSync(path.join(snap,'varaq.sqlite'));
 db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items(id) VALUES(3);');db.close();
 fs.mkdirSync(path.join(snap,'digital-pdfs'));
 fs.writeFileSync(path.join(snap,'digital-pdfs','test.pdf'),'%PDF-1.4 sample file');
 backup.makeManifest(snap);
 const before=fs.readFileSync(path.join(snap,'varaq.sqlite'));
 const good=recovery.rehearse({dataDir:data});
 assert.equal(good.passed,true,JSON.stringify(good));assert.equal(good.verifiedFiles,2);
 assert.deepEqual(fs.readFileSync(path.join(snap,'varaq.sqlite')),before);
 fs.writeFileSync(path.join(snap,'digital-pdfs','test.pdf'),'BAD');
 assert.equal(recovery.rehearse({backupDir:snap}).passed,false);
 assert.equal(recovery.rehearse({dataDir:data}).passed,false);
});
test('6.0: release decision never auto-approves commercial or public release',()=>{
 const good={source:{passed:true},backup:{passed:true},audit:{readyForInformationPreview:true,readyForPublicSales:false,paymentEnabled:false,checks:[]},smoke:{passed:true}};
 const r=decide(good);assert.equal(r.technicalPreviewCandidate,true);assert.equal(r.commercialSalesApproved,false);assert.equal(r.publicPreviewApproved,false);assert.equal(r.browserVisualQaPerformed,false);
 assert.equal(decide({...good,smoke:null}).technicalPreviewCandidate,false);
 assert.equal(decide({...good,audit:{...good.audit,readyForPublicSales:true,paymentEnabled:true}}).technicalPreviewCandidate,false);
});
