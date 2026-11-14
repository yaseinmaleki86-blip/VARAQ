'use strict';
// VARAQ 1.1: add educational metadata to EXISTING books only. Never create imaginary catalog items.
const education = require('./education');
const HEADERS=['book_id','grade','track','subject','goal','material_type','exam_year'];
const MAX_ROWS=250;
function parseCSV(text){
 const source=String(text||'').replace(/^\uFEFF/,'');
 if(!source.trim()||Buffer.byteLength(source,'utf8')>175000)throw Error('فایل CSV خالی یا بزرگ‌تر از حد مجاز است.');
 const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<source.length;i++){
  const c=source[i];
  if(c==='"'){
   if(quoted&&source[i+1]==='"'){field+='"';i++;}
   else if(quoted){quoted=false;}
   else if(field===''){quoted=true;}
   else throw Error('علامت نقل‌قول CSV نامعتبر است.');
  }else if(c===','&&!quoted){row.push(field.trim());field='';}
  else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&source[i+1]==='\n')i++;row.push(field.trim());if(row.some(Boolean))rows.push(row);row=[];field='';}
  else field+=c;
  if(rows.length>MAX_ROWS+1)throw Error('حداکثر ۲۵۰ ردیف در هر فایل مجاز است.');
 }
 if(quoted)throw Error('نقل‌قول در CSV بسته نشده است.');
 row.push(field.trim());if(row.some(Boolean))rows.push(row);
 if(rows.length<2)throw Error('CSV باید سرستون و حداقل یک ردیف داشته باشد.');
 const header=rows.shift().map(x=>x.trim().toLowerCase());
 if(header.length!==HEADERS.length||header.some((x,i)=>x!==HEADERS[i]))throw Error('ترتیب ستون‌ها باید دقیقاً مطابق فایل نمونه باشد.');
 if(rows.length>MAX_ROWS)throw Error('حداکثر ۲۵۰ ردیف در هر فایل مجاز است.');
 return rows.map((parts,i)=>{
  if(parts.length!==HEADERS.length)throw Error('ستون‌های ردیف '+(i+2)+' ناقص یا اضافی هستند.');
  const result={line:i+2};for(let j=0;j<HEADERS.length;j++)result[HEADERS[j]]=parts[j];return result;
 });
}
function preview(db,text){
 const entries=parseCSV(text),valid=[],issues=[],seen=new Set();
 for(const r of entries){
  const id=Number(r.book_id);
  if(!/^\d+$/.test(r.book_id)||!Number.isSafeInteger(id)||id<1){issues.push(`ردیف ${r.line}: شناسه کتاب باید عدد مثبت موجود باشد.`);continue;}
  if(seen.has(id)){issues.push(`ردیف ${r.line}: شناسه کتاب در فایل تکراری است.`);continue;}seen.add(id);
  const book=db.prepare('SELECT id,title,author FROM books WHERE id=?').get(id);
  if(!book){issues.push(`ردیف ${r.line}: کتاب با شناسه ${id} در بانک موجود نیست.`);continue;}
  if(db.prepare('SELECT book_id FROM education_profiles WHERE book_id=?').get(id)){
   issues.push(`ردیف ${r.line}: این کتاب قبلاً پرونده آموزشی دارد؛ فقط از فرم ویرایش استفاده کن.`);continue;
  }
  try{
   const item=education.validate({...r,published:'0'});
   valid.push({line:r.line,book,title:book.title,profile:item});
  }catch(e){issues.push(`ردیف ${r.line}: ${e.message}`);}
 }
 return {valid,issues,total:entries.length};
}
function commit(db,text){
 db.exec('BEGIN IMMEDIATE');
 try{
  const result=preview(db,text);let inserted=0;
  for(const item of result.valid){
   // Remain drafts; publication requires an explicit owner action for each source.
   const p=item.profile;
   db.prepare(`INSERT INTO education_profiles(book_id,grade,track,subject,goal,material_type,exam_year,published)
      VALUES(?,?,?,?,?,?,?,0)`).run(p.bookId,p.grade,p.track,p.subject,p.goal,p.materialType,p.year);
   inserted++;
  }
  db.exec('COMMIT');return {...result,inserted};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
const template='\uFEFF'+HEADERS.join(',')+'\r\n';
module.exports={parseCSV,preview,commit,HEADERS,MAX_ROWS,template};
