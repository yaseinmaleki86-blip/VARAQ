'use strict';
// VARAQ 8.0: public, paginated discovery of LICENSED and ACTIVE digital books.
// This module never returns the vault filename, file hash, rights evidence or payment token.
// It deliberately cannot grant purchases or expose downloadable PDF bytes.
const rights=require('./pdf-rights');
const {normalize:normalizeFa}=require('./discovery');
const PAGE_SIZE=12;
const SORTS={latest:'d.id DESC',title:'d.title COLLATE NOCASE ASC, d.id DESC',price_asc:'d.price ASC, d.id DESC',price_desc:'d.price DESC, d.id DESC'};
const clean=(value,max)=>String(value??'').trim().slice(0,max);
const hasBookCategory=db=>db.prepare('PRAGMA table_info(books)').all().some(col=>col.name==='category');
function positiveInt(raw){const n=Number(raw);return Number.isSafeInteger(n)&&n>0?n:0;}
const searchField=column=>{let expression=`lower(COALESCE(${column},''))`;for(const [oldChar,newChar] of [...[['ي','ی'],['ى','ی'],['ك','ک'],['ة','ه'],['آ','ا'],['أ','ا'],['إ','ا'],['ٱ','ا'],['ؤ','و'],['ئ','ی'],['\u200c',' '],['\u200d',' '],['-',' ']],...[...'۰۱۲۳۴۵۶۷۸۹'].map((d,i)=>[d,String(i)]),...[...'٠١٢٣٤٥٦٧٨٩'].map((d,i)=>[d,String(i)])])expression=`replace(${expression},'${oldChar}','${newChar}')`;return expression;};
const SEARCH_FIELDS=['d.title','d.description','b.author','b.title'].map(searchField);
const FROM=`FROM digital_books d JOIN stores s ON s.id=d.store_id LEFT JOIN books b ON b.id=d.book_id`;
const BASE=`d.status='approved' AND s.active=1 AND d.distribution_hold=0
 AND (d.rights_expires_on='' OR d.rights_expires_on>=?)`;
function normalize(input={}){
 return {q:clean(input.q,80),store:positiveInt(input.store),category:clean(input.category,100),
  sort:Object.hasOwn(SORTS,input.sort)?input.sort:'latest',page:positiveInt(input.page)||1};
}
function where(filters,day,categoryAvailable){
 const args=[day];let sql=BASE;
 if(filters.q){
  const words=normalizeFa(filters.q).split(' ').filter(Boolean).slice(0,8);
  if(!words.length)sql+=' AND 1=0';
  else {
   // When a query contains a one-letter token, requiring the whole phrase avoids
   // falsely matching unrelated titles containing that ubiquitous single letter.
   const terms=words.length>1&&words.some(w=>w.length<2)?[words.join(' ')]:words;
   for(const word of terms){
    // instr matches literal text; there are no LIKE wildcard or SQL injection tokens.
    sql+=' AND ('+SEARCH_FIELDS.map(field=>`instr(${field},?)>0`).join(' OR ')+')';
    args.push(...SEARCH_FIELDS.map(()=>word));
   }
  }
 }
 if(filters.store){sql+=' AND s.id=?';args.push(filters.store);}
 if(filters.category){if(categoryAvailable){sql+=' AND b.category=?';args.push(filters.category);}else sql+=' AND 1=0';}
 return {sql,args};
}
function facets(db,day=rights.todayTehran()){
 // Only public, approved, non-expired inventory contributes facet choices.
 const stores=db.prepare(`SELECT s.id,s.name,COUNT(*) total ${FROM} WHERE ${BASE} GROUP BY s.id,s.name ORDER BY s.name`).all(day);
 const categories=hasBookCategory(db)?db.prepare(`SELECT b.category name,COUNT(*) total ${FROM} WHERE ${BASE}
  AND b.category IS NOT NULL AND trim(b.category)<>'' GROUP BY b.category ORDER BY COUNT(*) DESC,b.category ASC`).all(day):[];
 return {stores,categories};
}
function browse(db,input={},day=rights.todayTehran()){
 const filters=normalize(input),categoryAvailable=hasBookCategory(db),condition=where(filters,day,categoryAvailable);
 const total=db.prepare(`SELECT COUNT(*) n ${FROM} WHERE ${condition.sql}`).get(...condition.args).n;
 const pages=Math.max(1,Math.ceil(total/PAGE_SIZE));
 const page=Math.min(filters.page,pages);
 const rows=db.prepare(`SELECT d.id,d.book_id,d.title,d.description,d.price,d.file_bytes,
   s.name store_name,s.id store_id,b.slug book_slug,b.title print_title,b.author,${categoryAvailable?'b.category':"''"} category
   ${FROM} WHERE ${condition.sql} ORDER BY ${SORTS[filters.sort]} LIMIT ? OFFSET ?`)
  .all(...condition.args,PAGE_SIZE,(page-1)*PAGE_SIZE);
 return {items:rows,total,pages,page,pageSize:PAGE_SIZE,filters};
}
module.exports={browse,facets,normalize,PAGE_SIZE};
