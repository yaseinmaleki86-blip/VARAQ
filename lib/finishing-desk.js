'use strict';
// Read-only workbench: combines actual catalog gaps, documented editions and
// local media health. This never treats metadata/rights claims as legal proof.
const {safeRows}=require('./media-integrity');
const MODES=['all','cover','author','publisher','description','source','stock'];
function scan(db,dataDir){
 const images=safeRows(db,dataDir),valid=new Set();
 for(const m of images){if(['book_cover','edition_cover'].includes(m.type)&&m.state==='ok')valid.add(Number(m.book_id));}
 const sourced=db.prepare(`SELECT e.book_id,COUNT(DISTINCT e.id) n FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.verified=1 AND trim(s.source_url)<>'' GROUP BY e.book_id`).all();
 const sourceMap=new Map(sourced.map(x=>[x.book_id,x.n]));
 const pending=db.prepare(`SELECT e.book_id,e.isbn,e.publisher,e.id FROM editions e LEFT JOIN edition_cover_assets c ON c.edition_id=e.id WHERE e.verified=1 AND e.isbn<>'' AND c.edition_id IS NULL ORDER BY e.id`).all();
 const pendingMap=new Map();for(const e of pending)if(!pendingMap.has(e.book_id))pendingMap.set(e.book_id,e);
 const counts=db.prepare(`SELECT si.book_id,COUNT(*) n FROM stock_items si JOIN stores st ON st.id=si.store_id WHERE si.active=1 AND si.quantity>0 AND st.active=1 GROUP BY si.book_id`).all();
 const stockMap=new Map(counts.map(x=>[x.book_id,x.n]));
 return db.prepare('SELECT id,title,author,publisher,description,category FROM books ORDER BY id').all().map(b=>{
  const gaps=[];if(!b.author.trim())gaps.push('author');if(!b.publisher.trim())gaps.push('publisher');
  if(!b.description.trim())gaps.push('description');if(!sourceMap.has(b.id))gaps.push('source');
  if(!valid.has(b.id))gaps.push('cover');
  const edition=pendingMap.get(b.id);
  return {...b,gaps,local_cover:valid.has(b.id),documented_editions:sourceMap.get(b.id)||0,
   stocked_skus:stockMap.get(b.id)||0,upload_isbn:edition?.isbn||'',edition_publisher:edition?.publisher||''};
 });
}
function select(rows,{mode='all',q='',page=1,perPage=20}={}){
 if(!MODES.includes(mode))mode='all';q=String(q||'').trim().slice(0,80);
 const search=q.toLocaleLowerCase('fa');
 const matching=rows.filter(b=>{
  if(mode==='stock'&&!b.stocked_skus)return false;
  if(mode!=='stock'&&mode!=='all'&&!b.gaps.includes(mode))return false;
  return !search||[b.title,b.author,b.publisher,b.category,String(b.id),b.upload_isbn].some(v=>String(v||'').toLocaleLowerCase('fa').includes(search));
 });
 matching.sort((a,b)=>(b.stocked_skus>0)-(a.stocked_skus>0)||b.gaps.length-a.gaps.length||a.id-b.id);
 const totalPages=Math.max(1,Math.ceil(matching.length/perPage));
 page=Math.max(1,Math.min(totalPages,Math.floor(Number(page)||1)));
 return {mode,q,page,totalPages,total:matching.length,items:matching.slice((page-1)*perPage,page*perPage),all:matching,
  stats:{books:rows.length,incomplete:rows.filter(x=>x.gaps.length).length,missingCovers:rows.filter(x=>x.gaps.includes('cover')).length,
   missingAuthor:rows.filter(x=>x.gaps.includes('author')).length,missingDescriptions:rows.filter(x=>x.gaps.includes('description')).length}};
}
function cell(value){let s=String(value??'').replace(/[\x00-\x1f\x7f]/g,' ');if(/^[\s\uFEFF]*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csv(rows){const keys=['id','title','author','publisher','category','documented_editions','stocked_skus','local_cover','upload_isbn','gaps'];
 return '\uFEFF'+[keys,...rows.map(r=>keys.map(k=>k==='gaps'?r.gaps.join('; '):r[k]))].map(a=>a.map(cell).join(',')).join('\r\n')+'\r\n';}
module.exports={scan,select,csv,MODES};
