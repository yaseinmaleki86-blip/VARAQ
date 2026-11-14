'use strict';
// A worklist based on actual verified ISBN/edition records. Never invent a cover,
// claim permission, or retrieve publisher media without explicit evidence.
const bibliography=require('./bibliography');
function pending(db){
 const rows=db.prepare(`SELECT e.id edition_id,e.book_id,e.isbn,e.publisher,e.translator,b.title,b.author,
  (SELECT s.source_url FROM edition_sources s WHERE s.edition_id=e.id AND trim(s.source_url)<>'' ORDER BY s.rowid DESC LIMIT 1) source_url,
  (SELECT count(*) FROM stock_items si JOIN stores st ON st.id=si.store_id
   WHERE si.edition_id=e.id AND si.active=1 AND si.quantity>0 AND st.active=1) stock_count
 FROM editions e JOIN books b ON b.id=e.book_id
 LEFT JOIN edition_cover_assets a ON a.edition_id=e.id
 WHERE e.verified=1 AND e.isbn<>'' AND a.edition_id IS NULL
 ORDER BY stock_count DESC,b.id,e.id`).all();
 return rows.filter(x=>bibliography.isbnValid(x.isbn));
}
function filter(rows,q){const s=String(q||'').trim().toLocaleLowerCase('fa').slice(0,90);
 return s?rows.filter(x=>[x.isbn,x.title,x.publisher,x.translator,x.author,String(x.book_id)].some(v=>String(v||'').toLocaleLowerCase('fa').includes(s))):rows;
}
function cell(value){let s=String(value??'').replace(/[\x00-\x1f\x7f]/g,' ');
 if(/^[\s\uFEFF]*[=+@-]/.test(s))s="'"+s;
 return '"'+s.replace(/"/g,'""')+'"';
}
function worklistCsv(rows){const fields=['book_id','edition_id','title','author','isbn','publisher','translator','source_url','stores_with_stock','filename_to_supply','permission_verified_by','rights_document_reference'];
 return '\uFEFF'+[fields,...rows.map(r=>[r.book_id,r.edition_id,r.title,r.author,r.isbn,r.publisher,r.translator,r.source_url||'',r.stock_count,'','',''])].map(a=>a.map(cell).join(',')).join('\r\n')+'\r\n';
}
function importManifestTemplate(rows){
 // Exact header expected by import-covers.js. Blank cells are INTENTIONAL and
 // must be filled with actual filenames, publisher credit, and written rights proof.
 return '\uFEFFisbn,filename,source,rights_note,match_evidence,permission_evidence\r\n'+rows.map(r=>r.isbn+',,,,,').join('\r\n')+(rows.length?'\r\n':'');
}
module.exports={pending,filter,worklistCsv,importManifestTemplate};
