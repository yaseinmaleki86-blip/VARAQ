'use strict';
// VARAQ 8.2 — factual, read-only overview of all books and local concept artwork.
// Neither an image file nor a verified edition proves permission to reproduce a publisher cover.
const fs=require('node:fs');
const path=require('node:path');
const editorial=require('./generated-editorial-review');
const media=require('./media-integrity');
const {validateImage}=require('./images');
const {normalize:normalizeFa}=require('./discovery');
const MODES={all:'همه کتاب‌ها',priority:'نیازمند رسیدگی',art:'اختلال طرح گرافیکی',intro:'معرفی خالی',editorial:'معرفی بازبینی‌نشده',author:'نویسنده نامشخص',publisher:'ناشر نامشخص',sources:'فاقد منبع چاپ',cover:'فاقد جلد محلی معتبر'};
function validWebp(file,expectedWidth=0,expectedHeight=0,minimum=false){
 try{
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size<32||st.size>700*1024)return false;
  const meta=validateImage(fs.readFileSync(file));
  return meta.mime==='image/webp'&&(!expectedWidth||(minimum?meta.width>=expectedWidth:meta.width===expectedWidth))&&(!expectedHeight||(minimum?meta.height>=expectedHeight:meta.height===expectedHeight))&&(!minimum||Math.abs(meta.width/meta.height-5/7)<0.01);
 }catch{return false;}
}
function localCoverOK(dataDir,name,mime){
 if(typeof name!=='string'||!/^[a-zA-Z0-9_.-]{1,130}$/.test(name)||name==='.'||name==='..')return false;
 return media.checkCover(path.join(dataDir,'covers'),name,mime).state==='ok';
}
function scan(db,{root,dataDir,catalogue}){
 const generated=new Map(catalogue.map(x=>[x.id,x]));
 const sourceRows=db.prepare(`SELECT e.book_id,COUNT(DISTINCT e.id) AS total FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.verified=1 AND trim(s.source_url)<>'' GROUP BY e.book_id`).all();
 const sourceCounts=new Map(sourceRows.map(x=>[x.book_id,x.total]));
 const officialRows=db.prepare(`SELECT b.id AS book_id,
  (SELECT c.filename FROM edition_cover_assets c JOIN editions e ON e.id=c.edition_id WHERE e.book_id=b.id AND e.verified=1 ORDER BY e.id DESC LIMIT 1) AS edition_file,
  (SELECT c.mime FROM edition_cover_assets c JOIN editions e ON e.id=c.edition_id WHERE e.book_id=b.id AND e.verified=1 ORDER BY e.id DESC LIMIT 1) AS edition_mime,
  (SELECT c.filename FROM book_covers c WHERE c.book_id=b.id) AS book_file,
  (SELECT c.mime FROM book_covers c WHERE c.book_id=b.id) AS book_mime
 FROM books b`).all();
 const officialById=new Map(officialRows.map(x=>[x.book_id,x]));
 const stockRows=db.prepare(`SELECT i.book_id,COUNT(*) AS total FROM stock_items i JOIN stores s ON s.id=i.store_id WHERE i.active=1 AND i.quantity>0 AND s.active=1 GROUP BY i.book_id`).all();
 const stockById=new Map(stockRows.map(x=>[x.book_id,x.total]));
 return db.prepare('SELECT id,slug,title,author,publisher,description,category FROM books ORDER BY id').all().map(b=>{
  const raw=generated.get(b.id),entry=raw?.title===b.title?raw:null;
  const intro=String(b.description||'').trim(),generatedIntro=String(entry?.description||'').trim();
  const editorialStatus=entry?editorial.record(db,entry).status:'missing';
  const image=path.join(root,'public','concept-art',`book-${String(b.id).padStart(3,'0')}.webp`);
  const thumbnail=path.join(root,'public','concept-thumb',`book-${String(b.id).padStart(3,'0')}.webp`);
  const artOK=validWebp(image,480,672,true),thumbOK=validWebp(thumbnail,240,336);
  const cover=officialById.get(b.id)||{};
  const localCover=localCoverOK(dataDir,cover.edition_file,cover.edition_mime)||localCoverOK(dataDir,cover.book_file,cover.book_mime);
  const issues=[];
  if(!artOK||!thumbOK)issues.push('art');
  if(!intro&&!generatedIntro)issues.push('intro');
  if(!intro&&editorialStatus!=='approved')issues.push('editorial');
  if(!String(b.author||'').trim())issues.push('author');
  if(!String(b.publisher||'').trim())issues.push('publisher');
  if(!sourceCounts.has(b.id))issues.push('sources');
  if(!localCover)issues.push('cover');
  return {...b,art_ok:artOK,thumb_ok:thumbOK,local_cover:localCover,official_cover_claim:'not_verified_by_technical_scan',
   custom_intro:!!intro,generated_intro:!!generatedIntro,editorial_status:editorialStatus,
   source_editions:sourceCounts.get(b.id)||0,stocked_skus:stockById.get(b.id)||0,issues};
 });
}
function select(rows,{mode='all',q='',page=1,perPage=18}={}){
 mode=Object.hasOwn(MODES,mode)?mode:'all';q=String(q??'').trim().slice(0,80);
 const terms=normalizeFa(q).split(' ').filter(Boolean).slice(0,8);
 const found=rows.filter(r=>{
  const modeHit=mode==='all'||(mode==='priority'?r.issues.length>0:r.issues.includes(mode));
  if(!modeHit)return false;
  const hay=normalizeFa([r.id,r.title,r.author,r.category,r.publisher].join(' '));
  return terms.every(word=>hay.includes(word));
 }).sort((a,b)=>(b.stocked_skus>0?1:0)-(a.stocked_skus>0?1:0)||b.issues.length-a.issues.length||a.id-b.id);
 const pp=Math.min(100,Math.max(1,Math.floor(Number(perPage)||18))),pages=Math.max(1,Math.ceil(found.length/pp));
 const p=Math.min(pages,Math.max(1,Math.floor(Number(page)||1)));
 return {items:found.slice((p-1)*pp,p*pp),all:found,total:found.length,page:p,pages,mode,q};
}
function summary(rows){return {total:rows.length,withArtwork:rows.filter(x=>x.art_ok&&x.thumb_ok).length,withGeneratedIntro:rows.filter(x=>x.custom_intro||x.generated_intro).length,
 editorialApproved:rows.filter(x=>x.custom_intro||x.editorial_status==='approved').length,
 localCovers:rows.filter(x=>x.local_cover).length,documentedEditions:rows.filter(x=>x.source_editions>0).length,
 missingAuthor:rows.filter(x=>x.issues.includes('author')).length,needsAttention:rows.filter(x=>x.issues.length>0).length};}
function csv(rows){
 const columns=['id','slug','title','author','category','publisher','concept_art_valid','thumbnail_valid','local_uploaded_cover_healthy','custom_intro','generated_intro','editorial_status','documented_verified_editions','stocked_skus','issues'];
 const cell=x=>{const v=String(x??'').replace(/[\x00-\x1f\x7f]/g,' ');const safe=/^[\s\uFEFF]*[=+@\-]/.test(v)?"'"+v:v;return '"'+safe.replace(/"/g,'""')+'"';};
 return '\ufeff'+[columns,...rows.map(r=>[r.id,r.slug,r.title,r.author,r.category,r.publisher,r.art_ok?1:0,r.thumb_ok?1:0,r.local_cover?1:0,r.custom_intro?1:0,r.generated_intro?1:0,r.editorial_status,r.source_editions,r.stocked_skus,r.issues.join(';')])].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
module.exports={scan,select,summary,csv,MODES,validWebp};
