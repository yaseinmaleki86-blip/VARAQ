'use strict';
// VARAQ 3.8: deterministic, permission-aware SEO primitives. No third-party calls.
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const escapeXml = escapeHtml;
const clean = (value,max=220) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const ld = data => `<script type="application/ld+json" nonce="__NONCE__">${JSON.stringify(data).replace(/</g,'\\u003c')}</script>`;
function openGraph({title,description,canonical,type='website',image=''}) {
 const tags=[['og:locale','fa_IR'],['og:site_name','ورق'],['og:type',type],['og:title',clean(title,140)],['og:description',clean(description,300)],['og:url',canonical],['twitter:card',image?'summary_large_image':'summary']];
 if(image && /^https?:\/\//.test(image))tags.push(['og:image',image],['twitter:image',image]);
 return tags.map(([property,value])=>`<meta ${property.startsWith('twitter:')?'name':'property'}="${property}" content="${escapeHtml(value)}">`).join('');
}
function siteSchema(base) {
 return ld({'@context':'https://schema.org','@graph':[
  {'@type':'WebSite','@id':base+'/#website',name:'ورق',url:base+'/',inLanguage:'fa-IR',potentialAction:{'@type':'SearchAction',target:base+'/books?q={search_term_string}','query-input':'required name=search_term_string'}},
  {'@type':'Organization','@id':base+'/#organization',name:'ورق',url:base+'/'}
 ]});
}
function breadcrumbs(base,items) {
 return ld({'@context':'https://schema.org','@type':'BreadcrumbList',itemListElement:items.map((x,i)=>({'@type':'ListItem',position:i+1,name:clean(x.name),item:base+x.path}))});
}
// Editions and references are distinguishable from a title-only placeholder.
// The gate is only used for public indexing; it NEVER hides books from readers.
function indexableBook(db,slug) {
 return Boolean(db.prepare(`SELECT 1 FROM books b WHERE b.slug=? AND trim(b.title)<>''
 AND trim(b.author)<>'' AND EXISTS (SELECT 1 FROM editions e JOIN edition_sources s ON s.edition_id=e.id
 WHERE e.book_id=b.id AND e.verified=1 AND trim(s.source_url)<>'')`).get(slug));
}
function indexableProfile(db,kind,name){
 if(kind==='author')return Boolean(db.prepare(`SELECT 1 FROM books b WHERE b.author=? AND EXISTS(
 SELECT 1 FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.book_id=b.id
 AND e.verified=1 AND trim(s.source_url)<>'' ) LIMIT 1`).get(name));
 if(kind==='publisher')return Boolean(db.prepare(`SELECT 1 FROM books b WHERE
 (b.publisher=? OR EXISTS(SELECT 1 FROM editions x WHERE x.book_id=b.id AND x.verified=1 AND x.publisher=?))
 AND EXISTS(SELECT 1 FROM editions e JOIN edition_sources s ON s.edition_id=e.id
 WHERE e.book_id=b.id AND e.verified=1 AND trim(s.source_url)<>'') LIMIT 1`).get(name,name));
 throw Error('Unknown profile type');
}
function indexableCategory(db,name){
 return Boolean(db.prepare(`SELECT 1 FROM books b WHERE b.category=? AND EXISTS(
 SELECT 1 FROM editions e JOIN edition_sources s ON s.edition_id=e.id WHERE e.book_id=b.id
 AND e.verified=1 AND trim(s.source_url)<>'') LIMIT 1`).get(name));
}
function approvedBooks(db){
 return db.prepare(`SELECT b.slug FROM books b WHERE trim(b.title)<>'' AND trim(b.author)<>''
 AND EXISTS (SELECT 1 FROM editions e JOIN edition_sources s ON s.edition_id=e.id
 WHERE e.book_id=b.id AND e.verified=1 AND trim(s.source_url)<>'') ORDER BY b.id`).all();
}
function xmlSitemap(base,paths){
 const origin=new URL(base).origin;
 const unique=[...new Set(paths)];
 return '<?xml version="1.0" encoding="utf-8"?>'+
 `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${unique.map(p=>{
  if(typeof p!=='string'||!p.startsWith('/')||p.startsWith('//'))throw Error('Invalid sitemap path');
  const url=new URL(p,origin);if(url.origin!==origin)throw Error('Cross-origin sitemap URL');
  return `<url><loc>${escapeXml(url.href)}</loc></url>`;
 }).join('')}</urlset>`;
}
module.exports={escapeHtml,openGraph,siteSchema,breadcrumbs,indexableBook,indexableProfile,indexableCategory,approvedBooks,xmlSitemap};
