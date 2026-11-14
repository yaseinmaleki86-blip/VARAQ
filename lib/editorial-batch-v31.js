'use strict';
// Human-authored copy for review. Never automatically put pending copy on public pages.
const entries=require('../data/editorial_drafts_v31.json');
const workflow=require('./catalog-workflow');
function eligible(db){
 return entries.map(x=>{
  const b=db.prepare('SELECT id,title,author,description FROM books WHERE id=?').get(x.book_id);
  if(!b)return {...x,available:false,reason:'book_missing'};
  const d=db.prepare('SELECT status FROM catalog_metadata_drafts WHERE book_id=?').get(x.book_id);
  if(d)return {...x,available:false,reason:'existing_draft',title:b.title};
  if(b.author.trim()&&b.description.trim())return {...x,available:false,reason:'already_complete',title:b.title};
  return {...x,available:true,title:b.title};
 });
}
function preview(db){const items=eligible(db);const ready=items.filter(x=>x.available).length;
 return {total:items.length,ready,skipped:items.length-ready,rows:items};}
function stage(db,userId){
 if(!Number.isSafeInteger(Number(userId))||Number(userId)<1)throw Error('ADMIN_REQUIRED');
 const items=eligible(db).filter(x=>x.available),checked=[];
 for(const x of items){const b=db.prepare('SELECT author,description FROM books WHERE id=?').get(x.book_id);
  const entry={book_id:x.book_id,author:b.author.trim()?'':x.author,description:b.description.trim()?'':x.description,source_url:'',source_note:x.source_note};
  if(!entry.author&&!entry.description)continue;
  workflow.checked(entry);checked.push(entry);
 }
 db.exec('BEGIN IMMEDIATE');try{
  for(const entry of checked)workflow.upsertDraft(db,entry,Number(userId));
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return {staged:checked.length,skipped:entries.length-checked.length};
}
module.exports={entries,preview,stage};
