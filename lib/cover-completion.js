'use strict';
// A fact-based queue; no unlicensed image is automatically published.
function rows(db){
 return db.prepare(`SELECT b.id,b.slug,b.title,b.author,b.publisher,b.description,b.isbn,b.category,
 (SELECT count(*) FROM editions e WHERE e.book_id=b.id AND e.verified=1) edition_count,
 (SELECT count(*) FROM edition_sources x JOIN editions e ON e.id=x.edition_id WHERE e.book_id=b.id) source_count,
 (SELECT count(*) FROM edition_cover_assets a JOIN editions e ON e.id=a.edition_id WHERE e.book_id=b.id) edition_cover_count,
 (SELECT count(*) FROM book_covers c WHERE c.book_id=b.id) cover_count,
 (SELECT e.isbn FROM editions e WHERE e.book_id=b.id AND e.verified=1 AND length(e.isbn)=13 ORDER BY e.id LIMIT 1) verified_isbn
 FROM books b ORDER BY b.id`).all().map(x=>{
  const missing=[];
  if(!x.author?.trim())missing.push('نویسنده');
  if(!x.description?.trim())missing.push('معرفی');
  if(!x.edition_count)missing.push('چاپ تأییدشده');
  if(!x.source_count)missing.push('منبع چاپ');
  if(!x.cover_count&&!x.edition_cover_count)missing.push('جلد مجاز');
  return {...x,missing,score:5-missing.length};
 });
}
const escaped=s=>{let v=String(s??'');if(/^[=+@\-\t\r]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"';};
function csv(data){const headings=['id','title','author','isbn','verified_isbn','missing','score','book_url','openlibrary_isbn_research'];const body=data.map(x=>[x.id,x.title,x.author,x.isbn,x.verified_isbn,x.missing.join(' | '),x.score,'/book/'+encodeURIComponent(x.slug),x.verified_isbn?'https://openlibrary.org/isbn/'+x.verified_isbn:'']);return '\uFEFF'+[headings,...body].map(row=>row.map(escaped).join(',')).join('\r\n')+'\r\n';}
function stats(data){return {total:data.length,withRealCover:data.filter(x=>x.cover_count+x.edition_cover_count>0).length,withDescription:data.filter(x=>x.description?.trim()).length,withAuthor:data.filter(x=>x.author?.trim()).length,fullyDocumented:data.filter(x=>!x.missing.length).length};}
module.exports={rows,csv,stats};
