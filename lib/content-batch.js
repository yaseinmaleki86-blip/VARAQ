'use strict';
// Owner-only, sourced catalogue completion. Adds facts only into empty fields.
// No image is fetched/published and existing descriptions are never overwritten.
const FIELDS=['author','publisher','description'];
const HEADERS=['book_id','author','publisher','description','source_url'];
function userError(message){const e=new Error(message);e.userError=true;throw e;}
function parseCsv(text){
 const raw=String(text||'').replace(/^\uFEFF/,'');
 if(Buffer.byteLength(raw,'utf8')>55000)userError('حجم متن CSV بیشتر از ۵۵ کیلوبایت است.');
 let fields=[],rows=[],part='',quoted=false;
 for(let i=0;i<raw.length;i++){
  const c=raw[i];
  if(c==='"'){
   if(quoted&&raw[i+1]==='"'){part+='"';i++;}
   else if(quoted)quoted=false;
   else if(!part.trim())quoted=true;
   else userError('نقل‌قول در CSV نامعتبر است.');
  }else if(c===','&&!quoted){fields.push(part.trim());part='';}
  else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&raw[i+1]==='\n')i++;fields.push(part.trim());if(fields.some(x=>x!==''))rows.push(fields);fields=[];part='';}
  else part+=c;
 }
 if(quoted)userError('نقل‌قول CSV بسته نشده است.');
 fields.push(part.trim());if(fields.some(x=>x!==''))rows.push(fields);
 if(rows.length<2||rows.length>51)userError('CSV باید بین ۱ تا ۵۰ کتاب داشته باشد.');
 const headers=rows.shift().map(x=>x.toLowerCase());
 if(headers.length!==5||!HEADERS.every((x,i)=>x===headers[i]))userError('سرستون‌ها باید دقیقاً book_id,author,publisher,description,source_url باشند.');
 const seen=new Set();return rows.map((values,index)=>{
  if(values.length!==5)userError('تعداد ستون‌های ردیف '+(index+2)+' نادرست است.');
  const row=Object.fromEntries(HEADERS.map((k,i)=>[k,values[i]]));
  const id=Number(row.book_id);
  if(!Number.isSafeInteger(id)||id<1||seen.has(id))userError('شناسه تکراری یا نامعتبر در ردیف '+(index+2));
  seen.add(id);row.book_id=id;
  if(!FIELDS.some(k=>row[k]))userError('هیچ اطلاعاتی برای تکمیل ردیف '+(index+2)+' وارد نشده است.');
  if(row.author.length>180||row.publisher.length>180||row.description.length>2400)userError('متن ردیف '+(index+2)+' بیش از حد مجاز است.');
  for(const f of ['author','publisher'])if(row[f]&&row[f].length<3)userError('متن '+f+' در ردیف '+(index+2)+' بسیار کوتاه است.');
  if(row.description&&row.description.length<100)userError('معرفی هر کتاب باید حداقل ۱۰۰ نویسه داشته باشد؛ ردیف '+(index+2));
  let url;try{url=new URL(row.source_url);}catch{userError('لینک منبع معتبر برای ردیف '+(index+2)+' لازم است.');}
  if(url.protocol!=='https:'||url.username||url.password||row.source_url.length>700||url.hostname==='localhost')userError('منبع باید لینک عمومی HTTPS معتبر باشد؛ ردیف '+(index+2));
  return row;
 });
}
function migrate(db){db.exec(`CREATE TABLE IF NOT EXISTS book_metadata_evidence (
 id INTEGER PRIMARY KEY,book_id INTEGER NOT NULL REFERENCES books(id),
 field TEXT NOT NULL CHECK(field IN ('author','publisher','description')),
 source_url TEXT NOT NULL, value_hash TEXT NOT NULL,
 actor_id INTEGER REFERENCES users(id), recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );CREATE INDEX IF NOT EXISTS idx_book_metadata_evidence ON book_metadata_evidence(book_id,field);`);}
const crypto=require('node:crypto');
function inspect(db,rows){
 return rows.map(row=>{
  const book=db.prepare('SELECT id,title,author,publisher,description FROM books WHERE id=?').get(row.book_id);
  if(!book)userError('کتاب با شناسه '+row.book_id+' پیدا نشد.');
  const changes=[];
  for(const f of FIELDS){
   if(!row[f])continue;
   if(String(book[f]||'').trim())userError('فیلد '+f+' کتاب «'+book.title+'» از قبل تکمیل است؛ بازنویسی خودکار ممنوع است.');
   changes.push({field:f,value:row[f],source_url:row.source_url});
  }
  return {book_id:book.id,title:book.title,changes};
 });
}
function apply(db,rows,actor){
 if(actor?.role!=='owner')userError('فقط مدیر مرکزی اجازه ثبت گروهی اطلاعات دارد.');
 db.exec('BEGIN IMMEDIATE');
 try{
  const report=inspect(db,rows);
  const stmt=Object.fromEntries(FIELDS.map(k=>[k,db.prepare(`UPDATE books SET ${k}=? WHERE id=? AND trim(${k})=''`)]));
  const evidence=db.prepare('INSERT INTO book_metadata_evidence(book_id,field,source_url,value_hash,actor_id) VALUES(?,?,?,?,?)');
  let changed=0;
  for(let i=0;i<report.length;i++)for(const c of report[i].changes){
   const result=stmt[c.field].run(c.value,report[i].book_id);
   if(result.changes!==1)userError('محتوای کتاب حین ثبت تغییر کرده؛ دوباره پیش‌نمایش بگیرید.');
   evidence.run(report[i].book_id,c.field,c.source_url,crypto.createHash('sha256').update(c.value).digest('hex'),actor.id);
   changed++;
  }
  db.exec('COMMIT');return {books:report.length,fields:changed};
 }catch(err){db.exec('ROLLBACK');throw err;}
}
module.exports={HEADERS,FIELDS,parseCsv,migrate,inspect,apply};
