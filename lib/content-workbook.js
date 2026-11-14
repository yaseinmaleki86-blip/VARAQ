'use strict';
// Export-only editorial worksheet: no unsourced metadata or covers are manufactured.
// Files match the five-column content-batch importer exactly (<=50 books per file).
const MODES=new Set(['all','author','publisher','description']);
const MAX_BATCH=50;
function all(db){
 return db.prepare(`SELECT b.id,b.title,b.author,b.publisher,b.description,
 (SELECT e.isbn FROM editions e WHERE e.book_id=b.id AND e.verified=1 AND e.isbn<>'' ORDER BY e.id LIMIT 1) isbn,
 (SELECT s.source_url FROM edition_sources s JOIN editions e ON e.id=s.edition_id WHERE e.book_id=b.id AND e.verified=1 AND trim(s.source_url)<>'' ORDER BY s.edition_id DESC LIMIT 1) edition_source,
 (SELECT COUNT(*) FROM edition_cover_assets c JOIN editions e ON e.id=c.edition_id WHERE e.book_id=b.id AND e.verified=1) uploaded_covers,
 (SELECT COUNT(*) FROM book_covers c WHERE c.book_id=b.id) book_covers
 FROM books b ORDER BY b.id`).all().map(r=>{
  const needs=['author','publisher','description'].filter(f=>!String(r[f]||'').trim());
  return {...r,needs,hasCover:!!(r.uploaded_covers+r.book_covers),
   needsReview:!!(String(r.description||'').trim()&&String(r.description).trim().length<100)};
 });
}
function select(db,params={}){
 const mode=MODES.has(params.missing)?params.missing:'all';
 const q=String(params.q||'').trim().slice(0,80).toLocaleLowerCase('fa');
 const candidates=all(db);
 const filtered=candidates.filter(x=>x.needs.length>0&&(mode==='all'||x.needs.includes(mode))&&
  (!q||[x.title,x.author,x.publisher,x.isbn,String(x.id)].some(v=>String(v||'').toLocaleLowerCase('fa').includes(q))));
 const pages=Math.max(1,Math.ceil(filtered.length/MAX_BATCH));
 const input=Number(params.batch);const batch=Number.isSafeInteger(input)?Math.max(1,Math.min(pages,input)):1;
 return {mode,q,total:filtered.length,batch,pages,items:filtered.slice((batch-1)*MAX_BATCH,batch*MAX_BATCH),
  stats:{books:candidates.length,incomplete:candidates.filter(x=>x.needs.length).length,
   missingAuthor:candidates.filter(x=>x.needs.includes('author')).length,
   missingPublisher:candidates.filter(x=>x.needs.includes('publisher')).length,
   missingDescription:candidates.filter(x=>x.needs.includes('description')).length,
   coverMissing:candidates.filter(x=>!x.hasCover).length}};
}
function cell(v){let s=String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
 if(/^[\s\uFEFF]*[=+@-]/.test(s))s="'"+s;
 return '"'+s.replace(/"/g,'""')+'"';
}
function csv(rows){
 const header=['book_id','author','publisher','description','source_url'];
 return '\uFEFF'+[header,...rows.map(r=>[r.id,'','','',''])].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';
}
function guide(rows){
 const header=['book_id','title','missing_fields','verified_isbn','edition_reference_for_research_only','has_uploaded_cover','description_needs_manual_review'];
 return '\uFEFF'+[header,...rows.map(r=>[r.id,r.title,r.needs.join('|'),r.isbn||'',r.edition_source||'',r.hasCover?'yes':'no',r.needsReview?'yes':'no'])].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';
}
module.exports={MAX_BATCH,all,select,csv,guide};
