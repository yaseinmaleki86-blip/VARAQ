'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');

test('7.6 core mobile HTTP smoke passes without external dependencies',()=>{
 const output=execFileSync(process.execPath,['tools/mobile-check.js','--json'],{cwd:root,encoding:'utf8',timeout:40000});
 const report=JSON.parse(output);
 assert.equal(report.version,'8.6.0');
 assert.equal(report.passed,true,report.checks.filter(x=>!x.passed).map(x=>x.name).join(', '));
 assert.ok(report.checks.length>=15);
});

test('7.6 touch controls have 44px minimum on narrow screens, and mobile inputs avoid iOS zoom',()=>{
 const css=fs.readFileSync(path.join(root,'public/style.css'),'utf8');
 const block=css.slice(css.indexOf('/* VARAQ 7.6'));
 assert.ok(block.includes('@media(max-width:740px)'));
 assert.match(block,/\.save-book-card\{width:44px;height:44px/);
 assert.match(block,/\.v68-card-actions a\{min-height:44px/);
 assert.match(block,/\.circle-arrow\{min-width:44px;min-height:44px/);
 assert.match(block,/font-size:16px;min-height:44px/);
 assert.match(block,/@media\(max-width:359px\)/);
 assert.match(block,/@media\(prefers-reduced-motion:reduce\)/);
});

test('7.6 HTML has a keyboard-accessible main landmark and preserves existing navigation',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 assert.match(server,/class="skip-link"/);
 assert.match(server,/<main id="main-content" tabindex="-1">/);
 assert.match(server,/class="mobile-bottom-nav"/);
 assert.match(server,/href="\/choose-format"/);
 assert.match(server,/href="\/pdf-books"/);
 const js=fs.readFileSync(path.join(root,'public/app.js'),'utf8');
 assert.match(js,/event\.key==='Escape'/);
 assert.match(js,/returnFocus/);
});

test('7.6 source keeps all 400 illustrated covers and startup/shutdown scripts',()=>{
 for(const sub of ['concept-art','concept-thumb']){
  const files=fs.readdirSync(path.join(root,'public',sub)).filter(n=>/^book-\d{3,4}\.webp$/.test(n));
  assert.equal(files.length,1000);
 }
 for(const file of ['START_WINDOWS.bat','STOP_ALL.bat','BACKUP_WINDOWS.bat','PREPARE_REMOVAL_WINDOWS.bat','MOBILE_QA_WINDOWS.bat']){
  assert.equal(fs.existsSync(path.join(root,file)),true,file);
 }
 const books=JSON.parse(fs.readFileSync(path.join(root,'data/books.json'),'utf8'));
 assert.equal(books.length,1000);
});
