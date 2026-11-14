'use strict';
// VARAQ 4.1: read-only publication *review* queue. A technical candidate is NOT
// a legal permission, editorial approval, physical-stock confirmation or sale.
// Deliberately do not persist automated judgements or turn on indexing/media.
function rows(db){
  return db.prepare(`SELECT b.id,b.slug,b.title,b.author,b.description,b.category,
    (SELECT COUNT(DISTINCT e.id) FROM editions e JOIN edition_sources s ON s.edition_id=e.id
      WHERE e.book_id=b.id AND e.verified=1 AND TRIM(s.source_url)<>'') sourced_editions,
    (SELECT COUNT(*) FROM book_covers c WHERE c.book_id=b.id) book_cover_claims,
    (SELECT COUNT(*) FROM edition_cover_assets a JOIN editions e ON e.id=a.edition_id
      WHERE e.book_id=b.id AND e.verified=1) uploaded_edition_covers,
    (SELECT COUNT(*) FROM edition_sources s JOIN editions e ON e.id=s.edition_id
      WHERE e.book_id=b.id AND e.verified=1 AND s.cover_matched=1 AND s.rights_confirmed=1 AND TRIM(s.cover_url)<>'') permitted_external_covers,
    (SELECT COUNT(*) FROM catalog_metadata_drafts d WHERE d.book_id=b.id AND d.status='pending') pending_drafts,
    (SELECT COUNT(*) FROM edition_rights_requests r JOIN editions e ON e.id=r.edition_id
      WHERE e.book_id=b.id AND e.verified=1 AND r.status='denied'
       AND (EXISTS(SELECT 1 FROM edition_cover_assets a WHERE a.edition_id=e.id)
        OR EXISTS(SELECT 1 FROM edition_sources s WHERE s.edition_id=e.id AND s.rights_confirmed=1 AND s.cover_matched=1 AND TRIM(s.cover_url)<>''))) denied_cover_conflicts
    FROM books b ORDER BY b.id`).all().map(r=>{
      const hasAuthor=Boolean(String(r.author||'').trim());
      const hasIntro=String(r.description||'').trim().length>=100;
      const hasSource=r.sourced_editions>0;
      const hasCoverClaim=r.book_cover_claims+r.uploaded_edition_covers+r.permitted_external_covers>0;
      const hasConflict=r.denied_cover_conflicts>0;
      const hasPendingDraft=r.pending_drafts>0;
      const todo=[];
      if(hasConflict)todo.push('تعارض پرونده رد مجوز با تصویر قابل نمایش؛ بررسی فوری');
      if(!hasAuthor)todo.push('تکمیل نویسنده از منبع');
      if(!hasIntro)todo.push('معرفی کتاب حداقل ۱۰۰ نویسه، پس از بازبینی انسانی');
      if(!hasSource)todo.push('ثبت منبع مستقل چاپ و شابک');
      if(!hasCoverClaim)todo.push('ثبت جلد دارای سند حق استفاده یا حفظ جای‌خالی');
      if(hasPendingDraft)todo.push('بررسی پیشنهاد معلق');
      const technicalCandidate=hasAuthor&&hasIntro&&hasSource&&hasCoverClaim&&!hasConflict&&!hasPendingDraft;
      return {...r,hasAuthor,hasIntro,hasSource,hasCoverClaim,hasConflict,hasPendingDraft,
        technicalCandidate,seoCandidate:hasAuthor&&hasSource,todo};
    });
}
function summary(items){return {
 total:items.length,technicalCandidates:items.filter(x=>x.technicalCandidate).length,
 seoCandidates:items.filter(x=>x.seoCandidate).length,missingAuthor:items.filter(x=>!x.hasAuthor).length,
 missingIntro:items.filter(x=>!x.hasIntro).length,missingSource:items.filter(x=>!x.hasSource).length,
 missingCover:items.filter(x=>!x.hasCoverClaim).length,pendingDrafts:items.filter(x=>x.hasPendingDraft).length,
 rightsConflicts:items.filter(x=>x.hasConflict).length
};}
const MODES=['all','rights-conflict','missing-author','missing-intro','missing-source','missing-cover','pending-draft','technical-candidate','seo-candidate'];
function filter(items,mode='all',q=''){
 const val=MODES.includes(mode)?mode:'all';
 const search=String(q||'').trim().toLocaleLowerCase('fa').slice(0,80);
 return items.filter(r=>{
  if(val==='rights-conflict'&&!r.hasConflict)return false;
  if(val==='missing-author'&&r.hasAuthor)return false;
  if(val==='missing-intro'&&r.hasIntro)return false;
  if(val==='missing-source'&&r.hasSource)return false;
  if(val==='missing-cover'&&r.hasCoverClaim)return false;
  if(val==='pending-draft'&&!r.hasPendingDraft)return false;
  if(val==='technical-candidate'&&!r.technicalCandidate)return false;
  if(val==='seo-candidate'&&!r.seoCandidate)return false;
  return !search||[r.title,r.author,String(r.id)].some(s=>String(s||'').toLocaleLowerCase('fa').includes(search));
 });
}
function safeCell(value){let s=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ');if(/^[\s\uFEFF]*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csv(items){const fields=['book_id','title','slug','author','source_editions','has_intro_100','has_cover_rights_claim','pending_draft','denied_cover_conflict','seo_candidate','technical_review_candidate','next_actions'];
 const records=items.map(r=>[r.id,r.title,r.slug,r.author,r.sourced_editions,r.hasIntro?'yes':'no',r.hasCoverClaim?'yes':'no',r.hasPendingDraft?'yes':'no',r.hasConflict?'yes':'no',r.seoCandidate?'yes':'no',r.technicalCandidate?'yes':'no',r.todo.join(' | ')]);
 return '\uFEFF'+[fields,...records].map(r=>r.map(safeCell).join(',')).join('\r\n')+'\r\n';
}
function forBook(db,id){return rowsForBook(db,id);}
// Per-page state uses only three narrowly scoped indexed/primary-key checks, not the full queue.
function rowsForBook(db,id){
 const b=db.prepare('SELECT id,author,description FROM books WHERE id=?').get(id);if(!b)return null;
 const sourced=db.prepare(`SELECT COUNT(DISTINCT e.id) n FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.book_id=? AND e.verified=1 AND TRIM(s.source_url)<>''`).get(id).n;
 return {hasAuthor:!!String(b.author||'').trim(),hasIntro:String(b.description||'').trim().length>=100,hasSource:sourced>0};
}
module.exports={rows,summary,filter,csv,forBook,MODES};
