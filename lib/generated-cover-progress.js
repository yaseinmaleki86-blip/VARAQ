'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
// Read only installation receipts bound to the bundled catalogue title and bytes.
function load(root,books){
 const records=new Map(), folder=path.join(root,'data','ai-cover-progress');
 for(const b of books){
  const name=`book-${String(b.id).padStart(3,'0')}`;
  try{
   const r=JSON.parse(fs.readFileSync(path.join(folder,name+'.json'),'utf8'));
   if(r.id!==b.id||r.title!==b.title)continue;
   const full=fs.readFileSync(path.join(root,'public','concept-art',name+'.webp'));
   if(r.sha256&&crypto.createHash('sha256').update(full).digest('hex')!==r.sha256)continue;
   records.set(b.id,{...r,version:crypto.createHash('sha256').update(full).digest('hex').slice(0,12)});
  }catch{}
 }
 return records;
}
module.exports={load};
