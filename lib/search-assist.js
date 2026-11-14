'use strict';
// VARAQ 7.3 — bounded, catalog-grounded help for zero-result searches.
// This module never fabricates book records and never silently changes the user's query.
const {normalize}=require('./discovery');

function distance(a,b,limit){
 if(a===b)return 0;
 if(Math.abs(a.length-b.length)>limit)return limit+1;
 let previous=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){
  const current=[i]; let rowMinimum=i;
  for(let j=1;j<=b.length;j++){
   const n=Math.min(previous[j]+1,current[j-1]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));
   current[j]=n;rowMinimum=Math.min(rowMinimum,n);
  }
  if(rowMinimum>limit)return limit+1;
  previous=current;
 }
 return previous[b.length];
}
const threshold=token=>token.length<=4?1:token.length<=8?2:3;
function matchField(query,field){
 const text=normalize(field);
 if(!text)return Infinity;
 if(query===text)return 0;
 const queryWords=query.split(' ').filter(Boolean);
 const words=text.split(' ').filter(Boolean);
 if(!queryWords.length||!words.length)return Infinity;
 // A multi-word query must match every word. Don't suggest unrelated books
 // merely because they share a broad category or a single generic token.
 let total=0;
 for(const token of queryWords){
  const limit=threshold(token);
  let best=limit+1;
  for(const word of words){
   if(word===token){best=0;break;}
   const d=distance(token,word,limit);
   if(d<best)best=d;
  }
  if(best>limit)return Infinity;
  total+=best;
 }
 // Prefer near-exact titles over long titles with a common word.
 return total*10+Math.max(0,words.length-queryWords.length)*0.3;
}
function suggest(db,{q='',limit=5}={}){
 const query=normalize(String(q).slice(0,90));
 if(query.length<3||query.length>80||/^\d+$/.test(query))return [];
 const rows=db.prepare('SELECT id,slug,title,author FROM books ORDER BY id LIMIT 3000').all();
 return rows.map(book=>{
  const titleScore=matchField(query,book.title);
  const authorScore=matchField(query,book.author);
  const score=Math.min(titleScore,authorScore+5);
  return {...book,score};
 }).filter(x=>Number.isFinite(x.score)).sort((a,b)=>a.score-b.score||a.title.localeCompare(b.title,'fa')||a.id-b.id)
 .slice(0,Math.max(0,Math.min(6,Number(limit)||5)));
}
module.exports={distance,matchField,suggest};
