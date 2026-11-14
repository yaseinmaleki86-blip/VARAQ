'use strict';
// Optional on-demand candidate discovery. NOT automatic at startup; NEVER changes the catalogue.
// Google Books API reference: https://developers.google.com/books/docs/v1/using
const fs=require('node:fs');const path=require('node:path');
const root=path.join(__dirname,'..');const books=JSON.parse(fs.readFileSync(path.join(root,'data','books.json'),'utf8'));
const start=Math.max(0,Math.min(199,parseInt(process.argv[2]||'0',10)||0));
const count=Math.max(1,Math.min(200,parseInt(process.argv[3]||'20',10)||20));
const norm=s=>String(s||'').normalize('NFKC').replace(/[يى]/g,'ی').replace(/ك/g,'ک').replace(/[\u200c\s]+/g,' ').replace(/[\p{P}\p{S}]/gu,'').trim().toLowerCase();
const csv=s=>{s=String(s??'');if(/^[=+@-]/.test(s.trim()))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){const out=[['book_id','catalog_title','provider_title','authors','publisher','date','pages','isbn13','cover_candidate_url','reference_url','status']];
 for(const b of books.slice(start,start+count)){
  const query=new URL('https://www.googleapis.com/books/v1/volumes');query.searchParams.set('q','intitle:'+b.title);query.searchParams.set('maxResults','10');query.searchParams.set('printType','books');
  let item=null,err='needs_review';try{
   const controller=new AbortController();const stop=setTimeout(()=>controller.abort(),10000);
   let r;try{r=await fetch(query,{signal:controller.signal,headers:{'user-agent':'VARAQ-Book-Candidate-Review/1.9'}});}finally{clearTimeout(stop);}
   if(!r.ok){err='provider_http_'+r.status;}else{
    const body=await r.json();const matching=(body.items||[]).filter(i=>norm(i.volumeInfo?.title)===norm(b.title));
    item=matching.find(i=>(i.volumeInfo?.industryIdentifiers||[]).some(x=>x.type==='ISBN_13'))||matching[0]||null;
    if(item)err='match_title_only_not_verified';else err='no_exact_title_match';
   }
  }catch(e){err='provider_unavailable';}
  const v=item?.volumeInfo||{};const isbn=(v.industryIdentifiers||[]).find(x=>x.type==='ISBN_13')?.identifier||'';
  out.push([b.id,b.title,v.title||'',(v.authors||[]).join(' / '),v.publisher||'',v.publishedDate||'',v.pageCount||'',isbn,v.imageLinks?.thumbnail||'',v.infoLink||'',err]);
  process.stdout.write(`${b.id} ${b.title}: ${err}\n`);await delay(200);
 }
 const target=path.join(root,'data',`google_books_candidates_${start}_${count}.csv`);
 fs.writeFileSync(target,'\ufeff'+out.map(r=>r.map(csv).join(',')).join('\r\n')+'\r\n','utf8');
 console.log('Candidate report (NO AUTOMATIC PUBLICATION): '+target);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
