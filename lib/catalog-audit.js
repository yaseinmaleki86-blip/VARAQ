'use strict';
// Read-only book catalogue completeness audit; does not presume image rights or seller stock.
function rows(db){
 return db.prepare(`SELECT b.id,b.slug,b.title,b.author,b.category,
  (SELECT COUNT(*) FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.book_id=b.id AND e.verified=1 AND s.source_url<>'') AS sourced,
  (SELECT COUNT(*) FROM editions e WHERE e.book_id=b.id AND e.verified=1 AND e.isbn<>'') AS editionCount,
  (SELECT COUNT(*) FROM edition_cover_assets c JOIN editions e ON c.edition_id=e.id WHERE e.book_id=b.id AND e.verified=1) +
  (SELECT COUNT(*) FROM book_covers c WHERE c.book_id=b.id) +
  (SELECT COUNT(*) FROM editions e JOIN edition_sources s ON e.id=s.edition_id WHERE e.book_id=b.id AND e.verified=1 AND s.cover_matched=1 AND s.rights_confirmed=1 AND s.cover_url<>'') AS licensedCover
 FROM books b ORDER BY b.id`).all();
}
function summary(data){return {total:data.length,sourced:data.filter(x=>x.sourced>0).length,editions:data.reduce((v,x)=>v+x.sourced,0),licensedCover:data.filter(x=>x.licensedCover>0).length};}
function filterRows(data,status){if(status==='needs_source')return data.filter(x=>!x.sourced);if(status==='needs_cover')return data.filter(x=>!x.licensedCover);if(status==='needs_author')return data.filter(x=>!x.author.trim());if(status==='ready')return data.filter(x=>!!x.author.trim()&&x.sourced>0&&x.licensedCover>0);return data;}
function safeCell(s){const t=String(s??'').replace(/\r?\n/g,' ').trim();return /^[-=+@\t\r]/.test(t)?"'"+t:t;}
function csvCell(s){return '"'+safeCell(s).replace(/"/g,'""')+'"';}
function exportCsv(data){const heads=['book_id','title','author','category','source_linked_editions','has_permitted_real_cover','physical_copy_verified','next_action'];const lines=data.map(x=>[x.id,x.title,x.author,x.category,x.sourced,x.licensedCover>0?'yes':'no','not_yet_confirmed',!x.sourced?'verify ISBN, publisher and edition':!x.licensedCover?'upload licensed photo of exact physical edition':'confirm physical copy details'].map(csvCell).join(','));return '\ufeff'+heads.join(',')+'\n'+lines.join('\n')+'\n';}
module.exports={rows,summary,filterRows,exportCsv};
