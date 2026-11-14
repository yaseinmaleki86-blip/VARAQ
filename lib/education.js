"use strict";
// VARAQ 1.0 educational catalogue metadata, intentionally no invented study books.
const TRACKS = Object.freeze({general:'عمومی',experimental:'تجربی',mathematics:'ریاضی‌فیزیک',humanities:'علوم انسانی'});
const SUBJECTS = Object.freeze(['زیست‌شناسی','شیمی','فیزیک','ریاضی','حسابان','هندسه','آمار و احتمال','گسسته','علوم و فنون ادبی','فلسفه و منطق','اقتصاد','جامعه‌شناسی','تاریخ','جغرافیا','ادبیات فارسی','عربی','دین و زندگی','زبان انگلیسی','علوم تجربی','مطالعات اجتماعی','همه دروس','سایر']);
const GOALS = Object.freeze({test:'تست و کنکور',final:'امتحان نهایی',learning:'آموزش و یادگیری',review:'مرور و جمع‌بندی'});
const TYPES = Object.freeze({teaching:'درسنامه',tests:'کتاب تست',workbook:'کار و تمرین',exams:'نمونه سؤال',summary:'جمع‌بندی',mixed:'جامع'});
const GRADES = Object.freeze(Object.fromEntries([...Array(12)].map((_,i)=>[i+1,({1:'اول',2:'دوم',3:'سوم',4:'چهارم',5:'پنجم',6:'ششم',7:'هفتم',8:'هشتم',9:'نهم',10:'دهم',11:'یازدهم',12:'دوازدهم'})[i+1]]).concat([[13,'کنکور']] )));
function migrate(db){
 db.exec(`CREATE TABLE IF NOT EXISTS education_profiles(
  book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  grade INTEGER NOT NULL CHECK(grade BETWEEN 1 AND 13),
  track TEXT NOT NULL CHECK(track IN ('general','experimental','mathematics','humanities')),
  subject TEXT NOT NULL,
  goal TEXT NOT NULL CHECK(goal IN ('test','final','learning','review')),
  material_type TEXT NOT NULL CHECK(material_type IN ('teaching','tests','workbook','exams','summary','mixed')),
  exam_year INTEGER CHECK(exam_year IS NULL OR (exam_year BETWEEN 1400 AND 1500)),
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 );
 CREATE INDEX IF NOT EXISTS idx_education_filter ON education_profiles(published,grade,track,subject,goal,material_type);
 CREATE INDEX IF NOT EXISTS idx_education_year ON education_profiles(exam_year);`);
}
function yearCheckEarly(grade,year){return grade<=9 && year!=='';}
function validate(input){
 const bookId=Number(input.book_id),grade=Number(input.grade),examYear=String(input.exam_year??'').trim();
 const track=String(input.track??''),subject=String(input.subject??''),goal=String(input.goal??''),materialType=String(input.material_type??'');
 if(!Number.isSafeInteger(bookId)||bookId<1)throw Error('کتاب معتبر انتخاب نشده است.');
 if(!Object.hasOwn(GRADES,grade))throw Error('پایه تحصیلی معتبر نیست.');
 if(!Object.hasOwn(TRACKS,track))throw Error('رشته تحصیلی معتبر نیست.');
 if(grade<=9&&track!=='general')throw Error('برای پایه‌های اول تا نهم، رشته باید عمومی باشد.');
 if(grade>=10&&track==='general'&&grade===13)throw Error('برای منابع ویژه کنکور، رشته را مشخص کنید.');
 if(yearCheckEarly(grade, examYear))throw Error('سال کنکور فقط برای پایه دهم به بالا مجاز است.');
 if(!SUBJECTS.includes(subject))throw Error('درس انتخاب‌شده معتبر نیست.');
 if(!Object.hasOwn(GOALS,goal)||!Object.hasOwn(TYPES,materialType))throw Error('هدف یا نوع منبع معتبر نیست.');
 if(examYear&&!/^(14\d{2}|1500)$/.test(examYear))throw Error('سال کنکور باید عدد چهاررقمی معتبر باشد.');
 const year=examYear?Number(examYear):null;
 if(year!==null&&(year<1400||year>1500))throw Error('سال آزمون خارج از محدوده مجاز است.');
 const published=input.published==='1'||input.published===1?1:0;
 return {bookId,grade,track,subject,goal,materialType,year,published};
}
function upsert(db,input){
 const x=validate(input);
 if(!db.prepare('SELECT id FROM books WHERE id=?').get(x.bookId))throw Error('کتاب انتخاب‌شده در بانک ثبت نشده است.');
 db.prepare(`INSERT INTO education_profiles(book_id,grade,track,subject,goal,material_type,exam_year,published)
 VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET grade=excluded.grade,track=excluded.track,
 subject=excluded.subject,goal=excluded.goal,material_type=excluded.material_type,
 exam_year=excluded.exam_year,published=excluded.published,updated_at=CURRENT_TIMESTAMP`)
 .run(x.bookId,x.grade,x.track,x.subject,x.goal,x.materialType,x.year,x.published);
 return x;
}
function get(db,bookId,onlyPublished=false){return db.prepare(`SELECT * FROM education_profiles WHERE book_id=?${onlyPublished?' AND published=1':''}`).get(bookId);}
function filters(params){
 const raw=key=>String(params.get(key)??'').trim();
 const q=raw('q').slice(0,80),grade=Number(raw('grade'))||0,track=raw('track'),subject=raw('subject'),goal=raw('goal'),materialType=raw('material_type'),publisher=raw('publisher').slice(0,100),examYear=Number(raw('exam_year'))||0;
 const clean={q,grade:Object.hasOwn(GRADES,grade)?grade:0,track:Object.hasOwn(TRACKS,track)?track:'',subject:SUBJECTS.includes(subject)?subject:'',goal:Object.hasOwn(GOALS,goal)?goal:'',materialType:Object.hasOwn(TYPES,materialType)?materialType:'',publisher,examYear:Number.isSafeInteger(examYear)&&examYear>=1400&&examYear<=1500?examYear:0};
 const rawPage=Number(raw('page'));clean.page=Number.isSafeInteger(rawPage)?Math.max(1,Math.min(10000,rawPage)):1;
 return clean;
}
function search(db,query,admin=false){
 const f=query,terms=[],args=[];
 if(!admin)terms.push('ep.published=1');
 if(f.grade){terms.push('ep.grade=?');args.push(f.grade);}
 if(f.track){terms.push('ep.track=?');args.push(f.track);}
 if(f.subject){terms.push('ep.subject=?');args.push(f.subject);}
 if(f.goal){terms.push('ep.goal=?');args.push(f.goal);}
 if(f.materialType){terms.push('ep.material_type=?');args.push(f.materialType);}
 if(f.examYear){terms.push('ep.exam_year=?');args.push(f.examYear);}
 if(f.publisher){const pub='%'+f.publisher.replace(/[\\%_]/g,'\\$&')+'%';terms.push(`(b.publisher LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM editions ed WHERE ed.book_id=b.id AND ed.verified=1 AND ed.publisher LIKE ? ESCAPE '\\'))`);args.push(pub,pub);}
 if(f.q){
  const pattern='%'+f.q.replace(/[\\%_]/g,'\\$&')+'%';
  terms.push(`(b.title LIKE ? ESCAPE '\\' OR b.author LIKE ? ESCAPE '\\' OR b.publisher LIKE ? ESCAPE '\\' OR ep.subject LIKE ? ESCAPE '\\')`);
  args.push(pattern,pattern,pattern,pattern);
 }
 const where=terms.length?'WHERE '+terms.join(' AND '):'';
 const from=`FROM education_profiles ep JOIN books b ON b.id=ep.book_id ${where}`;
 const total=db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args).n;
 const perPage=18,offset=(f.page-1)*perPage;
 const rows=db.prepare(`SELECT b.*, ep.grade,ep.track,ep.subject,ep.goal,ep.material_type,ep.exam_year,ep.published,
 (SELECT MIN(si.price) FROM stock_items si JOIN stores st ON st.id=si.store_id LEFT JOIN editions ed ON ed.id=si.edition_id WHERE si.book_id=b.id AND si.active=1 AND si.quantity>0 AND st.active=1 AND (si.edition_id IS NULL OR ed.verified=1)) AS price
 ${from} ORDER BY ep.updated_at DESC,b.id DESC LIMIT ? OFFSET ?`).all(...args,perPage,offset);
 return {total,rows,perPage};
}
function label(row){return `${row.grade===13?'کنکور':'پایه '+(GRADES[row.grade]||'نامشخص')} · ${TRACKS[row.track]||''} · ${row.subject||''}`;}
module.exports={GRADES,TRACKS,SUBJECTS,GOALS,TYPES,migrate,validate,upsert,get,filters,search,label};
