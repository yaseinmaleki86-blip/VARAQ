'use strict';
// Offline image ingestion: manifest CSV + locally supplied images + proof of permission.
// Nothing is downloaded from the internet, no unknown image files are trusted.
const fs=require('node:fs');const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const editionCover=require('./edition-cover');
const bibliography=require('./bibliography');
const {validateImage}=require('./images');
const REQUIRED=['isbn','filename','source','rights_note','match_evidence','permission_evidence'];
function parseManifest(data){
 const text=String(data||'').replace(/^\uFEFF/,'');if(Buffer.byteLength(text)>180000)throw Error('Manifest too large');
 const lines=text.trim().split(/\r?\n/);if(lines.length<2)throw Error('Manifest is empty');
 const headers=lines.shift().split(',').map(x=>x.trim().toLowerCase());
 if(headers.length!==REQUIRED.length||!REQUIRED.every(x=>headers.includes(x)))throw Error('Manifest requires: '+REQUIRED.join(','));
 if(lines.length>150)throw Error('Maximum 150 images per batch');
 const seen=new Set(),seenFiles=new Set();
 return lines.map((line,index)=>{
  if(!line.trim())throw Error('Blank manifest row '+(index+2));
  // File and proof fields in this secure batch format must not contain CSV quotes/commas.
  if(/["\r\n]/.test(line)||line.split(',').length!==headers.length)throw Error('Plain comma-separated manifest values only; row '+(index+2));
  const obj=Object.fromEntries(headers.map((h,i)=>[h,line.split(',')[i].trim()]));
  const isbn=obj.isbn.replace(/[\s-]/g,'');
  if(!bibliography.isbnValid(isbn))throw Error('Invalid ISBN at row '+(index+2));
  if(!/^[\w.\-]+\.(?:jpe?g|png|webp)$/i.test(obj.filename)||obj.filename.startsWith('.'))throw Error('Unsafe filename at row '+(index+2));
  if(seen.has(isbn)||seenFiles.has(obj.filename.toLowerCase()))throw Error('Duplicate ISBN or file at row '+(index+2));
  seen.add(isbn);seenFiles.add(obj.filename.toLowerCase());
  if(obj.source.length<3||obj.source.length>160||obj.rights_note.length<12||obj.rights_note.length>240||obj.match_evidence.length<8||obj.permission_evidence.length<12)throw Error('Evidence is incomplete at row '+(index+2));
  return {...obj,isbn};
 });
}
function inspect(db,rows,folder){
 const root=fs.realpathSync(folder),result=[];
 for(const row of rows){
  const e=db.prepare('SELECT id,book_id,isbn,publisher,verified FROM editions WHERE isbn=?').get(row.isbn);
  if(!e||!e.verified)throw Error('Verified edition not found for ISBN '+row.isbn);
  if(db.prepare('SELECT 1 FROM edition_cover_assets WHERE edition_id=?').get(e.id))throw Error('Cover already exists for ISBN '+row.isbn+'; use panel for deliberate replacement');
  const filename=path.resolve(root,row.filename);
  if(path.dirname(filename)!==root)throw Error('Invalid image path');
  const stat=fs.lstatSync(filename);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Only regular files are accepted');
  const bytes=fs.readFileSync(filename),meta=validateImage(bytes);
  result.push({...row,editionId:e.id,bookId:e.book_id,publisher:e.publisher,bytes,meta});
 }
 return result;
}
function processRows(db,rows,folder,target,apply=false){
 // The dry run validates every image and the edition/ISBN mapping; no files are written.
 if(!apply){const ready=inspect(db,rows,folder);
  return {mode:'dry-run',ready:ready.length,items:ready.map(x=>({isbn:x.isbn,editionId:x.editionId,width:x.meta.width,height:x.meta.height}))};}
 // A multi-cover upload must be atomic. If the evidence insert or an image write
 // fails, rollback ALL database rows and unlink only images created by this call.
 const created=[];let begun=false;
 try{
  db.exec('BEGIN IMMEDIATE');begun=true;
  const ready=inspect(db,rows,folder); // recheck under the write lock
  for(const e of ready){
   const saved=editionCover.save(db,{bookId:e.bookId,editionId:e.editionId,image:e.bytes,
    alt:'جلد واقعی چاپ '+e.publisher+' با شابک '+e.isbn,source:e.source,
    rights:e.rights_note+' | سند: '+e.permission_evidence,permission:'1',matched:'1'},target);
   created.push(saved.filename);
   db.prepare('INSERT INTO edition_cover_import_evidence(edition_id,match_evidence,permission_evidence) VALUES(?,?,?)')
    .run(e.editionId,e.match_evidence,e.permission_evidence);
  }
  db.exec('COMMIT');begun=false;
  return {mode:'apply',saved:created.length,items:ready.map((e,i)=>({isbn:e.isbn,editionId:e.editionId,filename:created[i]}))};
 }catch(error){
  if(begun)try{db.exec('ROLLBACK');}catch{}
  for(const filename of created)try{fs.unlinkSync(path.join(target,filename));}catch{}
  throw error;
 }
}
module.exports={parseManifest,inspect,processRows};
