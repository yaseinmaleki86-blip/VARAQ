from pathlib import Path
import json,hashlib,re
ROOT=Path(__file__).resolve().parents[1]
books=json.loads((ROOT/'data/books.json').read_text())[:300]
introductions={int(line.split('|',1)[0]):line.split('|',1)[1].strip() for line in (ROOT/'data/exclusive_introductions_1_200.txt').read_text().splitlines() if line.strip()}
second={}
for line in (ROOT/'data/exclusive_content_201_300.txt').read_text().splitlines():
    if line.strip():
        ident,intro,summary=line.split('|',2)
        second[int(ident)]=(intro.strip(),summary.strip())
overrides={
 91:('مرور تاریخ جهان، خواننده را از تمدن‌های نخستین تا دگرگونی‌های سیاسی و اجتماعی دوران جدید همراه می‌کند.','این عنوان برای پیوندزدن رویدادهای پراکنده در تصویری پیوسته از گذشته مناسب است. تمدن، جنگ، دین و تغییر شیوه زندگی در کانون چنین مروری قرار می‌گیرند؛ چون نام نویسنده در فهرست حاضر مشخص نیست، جزئیات فصل‌بندی یا دیدگاه مؤلف به چاپ معینی نسبت داده نمی‌شود.'),
 185:('حالت بدن، فاصله و ژست در کنار گفتار، بخشی از معنای رابطه را می‌سازند.','زبان بدن به سرنخ‌های غیرکلامی مانند حالت چهره، جهت نگاه و وضعیت اندام‌ها می‌پردازد. این نشانه‌ها باید در بافت موقعیت و فرهنگ خوانده شوند و به‌تنهایی آشکارکننده قطعی نیت نیستند؛ عنوان مشترک است و شیوه دسته‌بندی یک نویسنده خاص، بدون تعیین اثر به آن نسبت داده نمی‌شود.'),
 191:('جان و کارن لوییس فرزندپروری را از دریچه نیازهای عاطفی و الگوهای طرحواره‌ای بررسی می‌کنند.','کتاب توضیح می‌دهد چگونه تجربه‌های رابطه والد و فرزند می‌توانند به شکل‌گیری الگوهای پایدار عاطفی کمک کنند. توجه به نیازهای اساسی، شناخت واکنش‌های خشمگینانه و ترمیم رابطه پس از تعارض، محور این راهنمای مبتنی بر طرحواره‌درمانی است.'),
 192:('فابر و مازلیش تجربه آموختن زبان تازه‌ای برای ارتباط با کودک را روایت می‌کنند.','نویسندگان با تکیه بر دیدگاه‌های هایم جینات، از تجربه والدبودن و تغییر شیوه پاسخ به کودک می‌گویند. پذیرش احساس، حفظ احترام و جداکردن ارزش شخص از رفتار، جایگزینی برای تحقیر و برچسب‌زدن می‌شود و رابطه را به مرکز تربیت برمی‌گرداند.'),
 193:('مجموعه مغز کودک من، رشد شناختی را به تجربه‌های ملموس فرزندپروری پیوند می‌دهد.','این مجموعه در جلدهای وابسته به سن، کارکردها و تغییرهای مغز کودک را برای والدین توضیح می‌دهد. شناخت توانایی‌های درحال‌رشد، بازی و رابطه خانوادگی چارچوب کلی آن است؛ بازه سنی و برنامه‌های یک جلد معین بدون تعیین جلد به عنوان کلی نسبت داده نمی‌شوند.')
}
sources={191:['https://www.arjmandpub.com/Book/1516'],192:['https://mahdroo.ir/shop/product/book-1415158-j5e9hd'],193:['https://koodak.tv/%D9%85%D8%BA%D8%B2-%DA%A9%D9%88%D8%AF%DA%A9-%D9%85%D9%86-%D8%A7%D8%B2-%DA%86%D9%87%D8%A7%D8%B1-%D8%AA%D8%A7-%D9%87%D9%81%D8%AA-%D8%B3%D8%A7%D9%84%DA%AF%DB%8C-%D8%B1%D8%A7%D9%87%DB%8C-%D8%A8%D8%A7/']}
records=[]
for b in books:
    i=b['id']
    intro,summary=second[i] if i>200 else (introductions[i],b['editorial_draft_fa'])
    if i in overrides:intro,summary=overrides[i]
    records.append({'id':i,'slug':b['slug'],'title':b['title'],'introduction':intro,'summary':summary,'status':'original_editorial_not_publisher_verified','text_origin':'VARAQ original editorial; not an excerpt from the book','sources':sources.get(i,[]),'scope_note': 'عنوان کلی؛ نویسنده یا جلد باید پیش از نسبت‌دادن جزئیات بیشتر تطبیق داده شود.' if i in [91,185,193,244] else ''})
assert len(records)==300 and [r['id'] for r in records]==list(range(1,301))
for field in ['introduction','summary']:
    normalized=[re.sub(r'\s+',' ',r[field]).strip() for r in records]
    assert len(set(normalized))==300,('duplicate',field)
    assert all(len(t)>=65 for t in normalized),('too short',field,[(r['id'],len(r[field])) for r in records if len(r[field])<65])
assert all(r['introduction']!=r['summary'] for r in records)
assert not any('از زوایای گوناگون' in r['summary'] or 'می‌توان از منظر خانواده، رشد' in r['summary'] for r in records)
out=ROOT/'data/exclusive_content_v990.json'
out.write_text(json.dumps({'schema':1,'target':300,'records':records},ensure_ascii=False,indent=2))
report={'target':300,'introductions':300,'summaries':300,'exact_duplicate_count':0,'different_intro_and_summary':True,'scope_notes':[r['id'] for r in records if r['scope_note']],'minimum_introduction_characters':min(len(r['introduction']) for r in records),'minimum_summary_characters':min(len(r['summary']) for r in records),'content_sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'editorial_note':'Original introductory summaries, not full-book text; not a claim that all bibliographic details or editions have been verified.'}
(ROOT/'data/CONTENT_QA_V990.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False))
