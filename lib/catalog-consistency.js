'use strict';
// VARAQ 5.6: read-only catalogue consistency screening, not factual, copyright,
// stock, or publication approval. Potential duplicate titles require manual review.
const media = require('./media-integrity');
const path = require('node:path');
const ISSUES = Object.freeze({
 invalid_isbn: {label:'شابک نامعتبر؛ تطبیق با نسخه فیزیکی',level:3},
 isbn_conflict: {label:'شابک یکسان برای چند عنوان مختلف',level:3},
 damaged_cover: {label:'فایل جلد ثبت‌شده خراب یا مفقود است',level:3},
 duplicate_title: {label:'عنوان مشابه در چند رکورد؛ بررسی دستی',level:2},
 suspect_description: {label:'معرفی دارای نشانه متن موقت یا کد',level:2},
 short_description: {label:'معرفی کوتاه‌تر از ۱۰۰ نویسه',level:1},
 missing_description: {label:'معرفی کتاب ثبت نشده',level:1},
 missing_author: {label:'نویسنده ثبت نشده',level:1},
 missing_publisher: {label:'ناشر در شناسنامه اصلی ثبت نشده',level:1}
});
const MODES = ['all','priority','isbn','duplicates','description','cover','missing','clean'];
const groupMap = {
 priority:['invalid_isbn','isbn_conflict','damaged_cover'],
 isbn:['invalid_isbn','isbn_conflict'],duplicates:['duplicate_title','isbn_conflict'],
 description:['suspect_description','short_description','missing_description'],
 cover:['damaged_cover'],missing:['missing_description','missing_author','missing_publisher']
};
const digits = s => String(s??'').replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632));
function isbn(v){return digits(v).replace(/[\s\u200c\u200d\u2010-\u2015\u2212\-]/g,'').toUpperCase();}
function validIsbn(value){
 const n=isbn(value);
 if(/^\d{13}$/.test(n)){
  const sum=[...n.slice(0,12)].reduce((acc,x,i)=>acc+Number(x)*(i%2?3:1),0);
  return (10-sum%10)%10===Number(n[12]);
 }
 if(/^\d{9}[\dX]$/.test(n)){
  const sum=[...n].reduce((acc,x,i)=>acc+(x==='X'?10:Number(x))*(10-i),0);
  return sum%11===0;
 }
 return false;
}
function normalTitle(v){
 return digits(String(v??'').normalize('NFKC').toLocaleLowerCase('fa'))
 .replace(/[يى]/g,'ی').replace(/ك/g,'ک').replace(/[\u064b-\u065f\u0670\u0640\u200c\u200d]/g,'')
 .replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
function suspectIntro(value){
 const t=String(value??'').trim();
 return /<\/?[a-z][^>]*>|\{\{[^}]+\}\}|(?:lorem\s+ipsum)|(?:در\s+دست\s+تکمیل|به\s+زودی\s+تکمیل|متن\s+آزمایشی|placeholder)/iu.test(t);
}
function scan(db,dataDir){
 const books=db.prepare('SELECT id,title,author,publisher,description,isbn,category FROM books ORDER BY id').all();
 const editions=db.prepare('SELECT id,book_id,isbn,publisher,verified FROM editions ORDER BY id').all();
 const byBook=new Map(books.map(b=>[b.id,[]]));
 const isbnOwners=new Map(),titleOwners=new Map();
 const addIsbn=(bookId,value)=>{
  if(!String(value??'').trim())return;
  const code=isbn(value);if(!isbnOwners.has(code))isbnOwners.set(code,new Set());
  isbnOwners.get(code).add(bookId);
  byBook.get(bookId)?.push({value:String(value),code});
 };
 for(const b of books){
  addIsbn(b.id,b.isbn);
  const title=normalTitle(b.title);if(title){if(!titleOwners.has(title))titleOwners.set(title,new Set());titleOwners.get(title).add(b.id);}
 }
 for(const e of editions)addIsbn(e.book_id,e.isbn);
 // Scan only referenced cover images: a catalogue review must not read every
 // paid digital PDF from disk just to check book metadata.
 const coverDir=path.join(dataDir,'covers'),brokenCover=new Set();
 const coverRows=[
  ...db.prepare('SELECT book_id,filename,mime FROM book_covers').all(),
  ...db.prepare('SELECT e.book_id,c.filename,c.mime FROM edition_cover_assets c JOIN editions e ON e.id=c.edition_id').all()
 ];
 for(const c of coverRows)if(media.checkCover(coverDir,c.filename,c.mime).state!=='ok')brokenCover.add(c.book_id);
 return books.map(b=>{
  const notes=[],codes=new Set(),items=byBook.get(b.id)||[];
  const add=(key,details='')=>{if(!codes.has(key)){codes.add(key);notes.push({code:key,label:ISSUES[key].label,level:ISSUES[key].level,details});}};
  const invalid=items.filter(x=>!validIsbn(x.value));
  if(invalid.length)add('invalid_isbn',invalid.map(x=>x.value).join('، '));
  const collisions=[...new Set(items.filter(x=>isbnOwners.get(x.code)?.size>1).map(x=>x.code))];
  if(collisions.length)add('isbn_conflict',collisions.join('، '));
  const title=normalTitle(b.title),duplicateIds=titleOwners.get(title)||new Set();
  if(duplicateIds.size>1)add('duplicate_title',[...duplicateIds].filter(x=>x!==b.id).join('، '));
  if(brokenCover.has(b.id))add('damaged_cover');
  const intro=String(b.description||'').trim();
  if(!intro)add('missing_description');
  else {if(suspectIntro(intro))add('suspect_description');if([...intro].length<100)add('short_description');}
  if(!String(b.author||'').trim())add('missing_author');
  if(!String(b.publisher||'').trim())add('missing_publisher');
  notes.sort((a,b)=>b.level-a.level||a.code.localeCompare(b.code));
  return {...b,isbns:[...new Set(items.map(x=>x.code))].join('، '),issues:notes,
   priority:notes.reduce((max,x)=>Math.max(max,x.level),0)};
 });
}
function select(rows,{mode='all',q='',page=1,perPage=20}={}){
 if(!MODES.includes(mode))mode='all';q=String(q||'').trim().slice(0,80);
 const term=q.toLocaleLowerCase('fa'),keys=groupMap[mode];
 const all=rows.filter(r=>{
  if(mode==='clean'&&r.issues.length)return false;
  if(keys&&!r.issues.some(x=>keys.includes(x.code)))return false;
  return !term||[r.title,r.author,r.publisher,r.category,r.isbns,String(r.id)]
   .some(x=>String(x||'').toLocaleLowerCase('fa').includes(term));
 });
 all.sort((a,b)=>b.priority-a.priority||b.issues.length-a.issues.length||a.id-b.id);
 const totalPages=Math.max(1,Math.ceil(all.length/perPage));
 page=Math.min(totalPages,Math.max(1,Math.floor(Number(page)||1)));
 return {all,items:all.slice((page-1)*perPage,page*perPage),mode,q,page,totalPages,total:all.length};
}
function summary(rows){
 const count=code=>rows.filter(x=>x.issues.some(y=>y.code===code)).length;
 return {books:rows.length,needingReview:rows.filter(x=>x.issues.length).length,critical:rows.filter(x=>x.priority>=3).length,
  invalidISBN:count('invalid_isbn'),conflictingISBN:count('isbn_conflict'),duplicateTitle:count('duplicate_title'),
  damagedCover:count('damaged_cover'),missingIntro:count('missing_description'),shortIntro:count('short_description')};
}
function cell(v){let s=String(v??'').replace(/[\x00-\x1f\x7f]/g,' ');if(/^[\s\uFEFF]*[=+@\-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csv(rows){
 const fields=['book_id','title','author','publisher','isbn_values','highest_level','issues','review_details','review_required'];
 const mapped=rows.map(r=>[r.id,r.title,r.author,r.publisher,r.isbns,r.priority,
  r.issues.map(x=>x.code).join('; '),r.issues.map(x=>x.details?x.label+': '+x.details:x.label).join(' | '),r.issues.length?'yes':'no']);
 return '\uFEFF'+[fields,...mapped].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
module.exports={scan,select,summary,csv,isbn,validIsbn,normalTitle,MODES,ISSUES};
