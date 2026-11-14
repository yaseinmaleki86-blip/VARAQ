'use strict';
// Files and SQLite database are verified before a recovery snapshot may be restored.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const FORMAT=1;
function shaFile(file){const h=crypto.createHash('sha256');h.update(fs.readFileSync(file));return h.digest('hex');}
function relativeFiles(root){
 const found=[];
 function scan(dir){
  for(const dirent of fs.readdirSync(dir,{withFileTypes:true})){
   const loc=path.join(dir,dirent.name);
   if(dirent.isSymbolicLink())throw Error('پیوند نمادین در پشتیبان مجاز نیست: '+loc);
   if(dirent.isDirectory())scan(loc);
   else if(dirent.isFile()){
    const rel=path.relative(root,loc).split(path.sep).join('/');
    if(rel==='manifest.json'||rel==='BACKUP_INFO.txt'||rel==='RESTORE_INFO.txt')continue;
    if(rel!=='varaq.sqlite'&&!/^(covers|store-documents|banners|digital-pdfs)\/[a-zA-Z0-9_.-]+$/.test(rel))throw Error('فایل نامعتبر در پشتیبان: '+rel);
    found.push(rel);
   }else throw Error('نوع فایل ناشناخته: '+loc);
  }
 }
 scan(root);
 return found.sort();
}
function sqliteStatus(file){
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  const result=db.prepare('PRAGMA integrity_check').all().map(x=>Object.values(x)[0]);
  const foreignKeys=db.prepare('PRAGMA foreign_key_check').all();
  return {ok:result.length===1&&result[0]==='ok'&&foreignKeys.length===0,integrity:result,foreignKeyErrors:foreignKeys.length};
 }finally{db.close();}
}
function makeManifest(root){
 const files=relativeFiles(root);
 if(!files.includes('varaq.sqlite'))throw Error('دیتابیس در نسخه پشتیبان موجود نیست');
 const sqlite=sqliteStatus(path.join(root,'varaq.sqlite'));
 if(!sqlite.ok)throw Error('پایگاه داده در تست سلامت موفق نبود: '+JSON.stringify(sqlite));
 const manifest={schema:FORMAT,app:'VARAQ',createdAt:new Date().toISOString(),files:files.map(relative=>{
  const p=path.join(root,...relative.split('/'));
  return {path:relative,size:fs.statSync(p).size,sha256:shaFile(p)};
 })};
 fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
 return manifest;
}
function verifyBackup(root){
 const file=path.join(root,'manifest.json');
 if(!fs.existsSync(file))throw Error('فایل manifest.json وجود ندارد؛ این نسخه پشتیبان قدیمی یا ناقص است.');
 const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
 if(manifest.schema!==FORMAT||manifest.app!=='VARAQ'||!Array.isArray(manifest.files))throw Error('فرمت نسخه پشتیبان شناخته‌شده نیست');
 const present=relativeFiles(root),listed=manifest.files.map(x=>x.path);
 if(new Set(listed).size!==listed.length||JSON.stringify([...listed].sort())!==JSON.stringify(present))throw Error('فهرست فایل‌های نسخه پشتیبان مغایرت دارد');
 for(const rec of manifest.files){
  if(typeof rec.path!=='string'||typeof rec.size!=='number'||!/^[a-f0-9]{64}$/.test(rec.sha256))throw Error('فهرست فایل‌ها مخدوش است');
  const p=path.join(root,...rec.path.split('/'));
  if(fs.statSync(p).size!==rec.size||shaFile(p)!==rec.sha256)throw Error('عدم تطابق فایل نسخه پشتیبان: '+rec.path);
 }
 const sqlite=sqliteStatus(path.join(root,'varaq.sqlite'));
 if(!sqlite.ok)throw Error('پایگاه داده نسخه پشتیبان معتبر نیست: '+JSON.stringify(sqlite));
 return {verified:true,fileCount:manifest.files.length,createdAt:manifest.createdAt,sqlite};
}
module.exports={makeManifest,verifyBackup,sqliteStatus};
