'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');

test('7.7 cards switch to readable horizontal single-column rows on narrow devices',()=>{
 const css=fs.readFileSync(path.join(root,'public/style.css'),'utf8');
 const section=css.slice(css.indexOf('/* VARAQ 7.7'));
 assert.match(section, /@media\(max-width:430px\)/);
 assert.match(section, /\.book-grid\{grid-template-columns:minmax\(0,1fr\)/);
 assert.match(section, /\.book-card-v48\{display:grid;grid-template-columns:104px/);
 assert.match(section, /@media\(max-width:340px\)/);
 assert.match(section, /\.v68-card-actions a\{font-size:11px;min-height:44px/);
 assert.match(section,/\.mobile-bottom-nav small\{font-size:10px;white-space:normal/);
});

test('7.7 live HTTP and asset smoke preserves payment gate and cross-page navigation',()=>{
 const output=execFileSync(process.execPath,['tools/mobile-check.js','--json'],{cwd:root,encoding:'utf8',timeout:40000});
 const report=JSON.parse(output);
 assert.equal(report.version,'8.6.0');
 assert.equal(report.passed,true,JSON.stringify(report.checks.filter(x=>!x.passed)));
 assert.ok(report.checks.find(x=>x.name==='narrow-single-column-cards'&&x.passed));
 assert.ok(report.checks.find(x=>x.name==='private-download-unavailable'&&x.passed));
});

test('7.7 leaves public PDF access private and supports optional offline browser audit',()=>{
 const app=fs.readFileSync(path.join(root,'server.js'),'utf8');
 assert.match(app,/payment_enabled:false/);
 assert.match(app,/version:'8.6.0'/);
 assert.ok(fs.existsSync(path.join(root,'tools/mobile-layout-audit.py')));
 for(const script of ['START_WINDOWS.bat','STOP_ALL.bat','BACKUP_WINDOWS.bat','MOBILE_QA_WINDOWS.bat','VISUAL_LAYOUT_QA_WINDOWS.bat']){
  assert.ok(fs.existsSync(path.join(root,script)),script);
 }
 for(const dir of ['concept-thumb','concept-art']){
  assert.equal(fs.readdirSync(path.join(root,'public',dir)).filter(n=>/^book-\d{3,4}\.webp$/.test(n)).length,1000);
 }
});
