'use strict';
// Compare published educational metadata only; avoid subjective or invented ranking.
const education=require('./education');
function idsFromParams(url){
 const params=url.searchParams.getAll('ids');let raw=params.flatMap(s=>s.split(','));
 if(raw.length<2||raw.length>3)throw Error('برای مقایسه باید دو یا سه کتاب انتخاب شود.');
 if(raw.some(x=>!/^\d+$/.test(x)))throw Error('شناسه کتاب معتبر نیست.');
 const ids=raw.map(Number);
 if(ids.some(x=>!Number.isSafeInteger(x)||x<1)||new Set(ids).size!==ids.length)throw Error('شناسه‌های انتخاب‌شده معتبر و غیرتکراری باشند.');
 return ids;
}
function get(db,ids){
 const rows=ids.map(id=>db.prepare(`SELECT b.id,b.slug,b.title,b.author,b.publisher,ep.grade,ep.track,ep.subject,
 ep.goal,ep.material_type,ep.exam_year
 FROM education_profiles ep JOIN books b ON b.id=ep.book_id WHERE ep.published=1 AND b.id=?`).get(id));
 if(rows.some(x=>!x))throw Error('یکی از کتاب‌ها موجود یا منتشرشده نیست.');
 return rows.map(row=>({...row,gradeLabel:education.GRADES[row.grade],trackLabel:education.TRACKS[row.track],goalLabel:education.GOALS[row.goal],typeLabel:education.TYPES[row.material_type]}));
}
module.exports={idsFromParams,get};
