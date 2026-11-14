#!/usr/bin/env python3
"""Non-destructive, audited import of a legacy VARAQ catalog into v9.2.

Requires a genuine legacy v8.6 ZIP or extracted directory. Does not execute
legacy JavaScript or import passwords, payments, orders, permissions, or ebooks.
"""
from __future__ import annotations
import argparse, collections, csv, datetime, hashlib, io, json, os, re, shutil, sqlite3, sys, tempfile, unicodedata, zipfile, secrets
from pathlib import Path
import app

MAX_ZIP_FILES = 55000
MAX_ZIP_SIZE = 1_800_000_000
MAX_FILE = 280_000_000
IMAGE_EXT = {'.jpg','.jpeg','.png','.webp'}
DB_EXT = {'.db','.sqlite','.sqlite3'}
TEXT_EXT = {'.json','.jsonl','.ndjson','.csv','.tsv','.js','.mjs','.cjs'}
BOOK_TERMS = ('book','catalog','product','seed','library','publication','کتاب','فهرست')
ALIASES = {
 'title':('title','name','book_title','book_name','title_fa','fa_title','persian_title','product_name','booktitle','عنوان','نام کتاب','عنوان کتاب'),
 'author':('author','authors','author_name','writer','writer_name','author_fa','authorfa','نویسنده'),
 'publisher':('publisher','publisher_name','publisher_fa','imprint','ناشر'),
 'isbn':('isbn','isbn13','isbn_13','isbn_10','isbn_code','شابک'),
 'year':('year','published_year','publication_year','publish_year','year_published','سال انتشار'),
 'category':('category','category_name','genre','subject','topic','category_fa','دسته بندی','دسته‌بندی','موضوع'),
 'description':('description','summary','summary_fa','summary_text','summary_persian','description_fa','synopsis','short_description','blurb','intro','introduction','overview','about','excerpt','review','book_summary','معرفی','خلاصه','توضیحات','چکیده'),
 'cover':('cover','cover_path','cover_file','cover_filename','cover_image','cover_url','cover_main','cover_webp','image','image_url','image_path','thumbnail','thumbnail_url','coverimage','book_cover','جلد'),
 'price':('price','price_toman','sale_price','final_price','price_irr','قیمت'),
 'stock':('stock','inventory','qty','quantity','available_qty','موجودی'),
 'source_id':('id','book_id','bookid','book_code','code','sku','slug','external_id'),
}


def label(s):
    raw=unicodedata.normalize('NFKC',str(s or '')).strip()
    raw=re.sub(r'(?<=[a-z0-9])(?=[A-Z])','_',raw)
    return raw.casefold().replace('ي','ی').replace('ك','ک')


def key_title(s):
    return re.sub(r'[^\w\u0600-\u06ff]+','',label(s))


def identity(book):
    """Do not collapse distinct editions of the same title into one book."""
    isbn=re.sub(r'[^0-9Xx]','',str(book.get('isbn') or ''))
    if len(isbn) in (10,13):return ('isbn',isbn.upper())
    return ('bibliography',key_title(book.get('title')),key_title(book.get('author')),key_title(book.get('publisher')))


def normalized(record):
    if not isinstance(record,dict):return None
    r={label(k):v for k,v in record.items()}
    out={}
    for k,opts in ALIASES.items():
        out[k]=next((r[label(a)] for a in opts if label(a) in r and r[label(a)] not in (None,'')), '')
    # A few legacy records store extended data within a JSON string column.
    for k in ('metadata','metadata_json','details','data'):
        if k in r and isinstance(r[k],str) and r[k].startswith('{') and len(r[k])<100000:
            try:sub=json.loads(r[k])
            except (ValueError,TypeError):continue
            if isinstance(sub,dict):
                ext=normalized(sub)
                if ext:
                    for field,val in ext.items():
                        if not out.get(field):out[field]=val
    title=str(out['title'] or '').strip()
    if not 2<=len(title)<=320:return None
    if not re.search(r'[\w\u0600-\u06ff]',title):return None
    for field in ('title','author','publisher','isbn','year','category','description','cover','source_id'):
        val=out[field]
        if isinstance(val,dict):val=next((val[k] for k in ('url','path','src','text','name','value') if k in val),'')
        if isinstance(val,list):val='، '.join(str(item) for item in val if item)
        out[field]=str(val or '').strip()
    if not out['category']:out['category']='عمومی'
    return out


def content_lists(node,depth=0):
    if depth>5:return
    if isinstance(node,list):
        if node and isinstance(node[0],dict):yield node
        return
    if isinstance(node,dict):
        for k,v in node.items():
            if isinstance(v,(dict,list)):
                yield from content_lists(v,depth+1)


def source_sets(root):
    skip={'.git','node_modules','venv','.venv','dist','build','__pycache__','backups','backup','uploads','.next'}
    for p in root.rglob('*'):
        if not p.is_file() or not p.resolve().is_relative_to(root.resolve()) or set(p.relative_to(root).parts)&skip or len(p.relative_to(root).parts)>12:continue
        ext=p.suffix.lower()
        if ext not in TEXT_EXT|DB_EXT or p.stat().st_size>MAX_FILE:continue
        if ext in TEXT_EXT and not any(t in label(p.stem) for t in BOOK_TERMS):continue
        try:
            if ext=='.csv' or ext=='.tsv':
                with p.open('r',encoding='utf-8-sig',newline='') as f:
                    rows=list(csv.DictReader(f,delimiter='\t' if ext=='.tsv' else ','))
                yield f'{p.relative_to(root)}',rows
            elif ext in ('.jsonl','.ndjson'):
                with p.open('r',encoding='utf-8-sig') as f:
                    rows=[json.loads(s) for s in f if s.strip()]
                yield str(p.relative_to(root)),rows
            elif ext=='.json':
                o=json.loads(p.read_text(encoding='utf-8-sig'))
                for i,items in enumerate(content_lists(o)):
                    yield f'{p.relative_to(root)}#{i}',items
            elif ext in ('.js','.cjs','.mjs'):
                # Parse only literal JSON arrays embedded in JavaScript. Never evaluate code.
                text=p.read_text(encoding='utf-8-sig')
                for match_num,match in enumerate(re.finditer(r'\[\s*\{',text)):
                    start=match.start();quoted=None;escaped=False;stack=[];end=None
                    for pos in range(start,min(len(text),start+18_000_000)):
                        char=text[pos]
                        if quoted:
                            if escaped:escaped=False
                            elif char=='\\':escaped=True
                            elif char==quoted:quoted=None
                        elif char in ('"',"'",'`'):quoted=char
                        elif char in ('[','{'):stack.append(char)
                        elif char in (']','}'):
                            if not stack:break
                            op=stack.pop()
                            if (op=='[' and char!=']') or (op=='{' and char!='}'):break
                            if not stack:end=pos+1;break
                    if end is None:continue
                    try:o=json.loads(text[start:end])
                    except ValueError:continue
                    if isinstance(o,list) and len(o)>=2:
                        yield f'{p.relative_to(root)}#js{match_num}',o
            else:
                conn=sqlite3.connect('file:'+str(p)+'?mode=ro&immutable=1',uri=True)
                conn.row_factory=sqlite3.Row
                try:
                    tables=[x[0] for x in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
                    for tab in tables:
                        if not any(t in label(tab) for t in ('book','catalog','product','publication')):continue
                        q='"'+tab.replace('"','""')+'"'
                        cols=[label(x['name']) for x in conn.execute('PRAGMA table_info('+q+')')]
                        if not any(label(a) in cols for a in ALIASES['title']):continue
                        count=conn.execute('SELECT count(*) FROM '+q).fetchone()[0]
                        if count>90000:continue
                        rows=[dict(x) for x in conn.execute('SELECT * FROM '+q)]
                        yield f'{p.relative_to(root)}::{tab}',rows
                finally:conn.close()
        except (OSError,UnicodeError,ValueError,sqlite3.Error,json.JSONDecodeError) as ex:
            print('SKIPPED SOURCE:',p.relative_to(root),type(ex).__name__,file=sys.stderr)


def canonical_v86(root):
    """Authoritative 8.6 catalogue: exact books + generated art by stable ID.

    Verification CSVs are *not* extra books. Never execute legacy JS or import
    legacy accounts, credentials, payments, or unknown inventory figures.
    """
    base = next((p for p in (root,root/'varaq') if
        (p/'data'/'books.json').is_file() and (p/'data'/'generated_catalog_v86.json').is_file()),None)
    if base is None:return None
    records=json.loads((base/'data'/'books.json').read_text(encoding='utf8'))
    generated=json.loads((base/'data'/'generated_catalog_v86.json').read_text(encoding='utf8'))
    if not isinstance(records,list) or not isinstance(generated,list):raise ValueError('Invalid canonical v8.6 catalogue format')
    bmap={int(b['id']):b for b in records}
    gmap={int(b['id']):b for b in generated}
    if len(bmap)!=len(records) or len(gmap)!=len(generated) or set(bmap)!=set(gmap):raise ValueError('Legacy book ids mismatch or duplicate')
    overrides_file=app.ROOT/'data'/'editorial_overrides_v95.json'
    overrides=json.loads(overrides_file.read_text(encoding='utf8')) if overrides_file.is_file() else {}
    out=[]
    for bid in sorted(bmap):
        a=bmap[bid];g=gmap[bid]
        if str(a.get('slug',''))!=str(g.get('slug','')) or a.get('title')!=g.get('title'):
            raise ValueError(f'Mismatched 8.6 book slug/title at id {bid}')
        art=str(g.get('image') or '')
        if not re.fullmatch(r'concept-art/book-\d{3,4}\.webp',art):raise ValueError('Unexpected 8.6 art path')
        # Use the book editorial draft as the canonical text; replace known
        # erroneous duplicates with a separate, explicitly-reviewed draft.
        desc=overrides.get(str(bid)) or a.get('editorial_draft_fa') or g.get('description') or ''
        out.append({'source_id':str(a.get('slug')),'title':str(a.get('title') or ''),
            'author':str(a.get('author') or ''),'publisher':str(a.get('publisher') or ''),
            'isbn':str(a.get('isbn') or ''),'year':'','category':str(a.get('category') or ''),
            'description':str(desc),'cover':'public/'+art,'price':0,'stock':0})
    return out,[{'source':'data/books.json + data/generated_catalog_v86.json','valid':len(out),'rows':len(out),'authoritative':True}],len(out)

def merge_records(root):
    exact=canonical_v86(root)
    if exact is not None:return exact
    # Prefer richer records; preserve distinct editions/authors and original metadata.
    grouped={};sources=[];source_rows=0
    for src,rows in source_sets(root):
        valid=[]
        for raw in rows:
            record=normalized(raw)
            if record:valid.append(record)
        if not valid:continue
        sources.append({'source':src,'valid':len(valid),'rows':len(rows)})
        source_rows+=len(valid)
        for book in valid:
            k=identity(book)
            existing=grouped.get(k)
            if existing:
                # Keep best description, and fill blanks without replacing source metadata.
                for field in ('description','cover'):
                    if len(str(book[field]))>len(str(existing.get(field,''))):existing[field]=book[field]
                for field in ('author','publisher','isbn','year','category','source_id','price','stock'):
                    if not existing.get(field):existing[field]=book[field]
                grouped[k]=existing
            else:
                grouped[k]=book
    return list(grouped.values()),sources,source_rows


def zip_to_dir(zfile,target):
    with zipfile.ZipFile(zfile) as z:
        items=z.infolist()
        if len(items)>MAX_ZIP_FILES or sum(v.file_size for v in items)>MAX_ZIP_SIZE:
            raise ValueError('حجم یا تعداد فایل ZIP بیشتر از محدوده ایمنی است.')
        names=set()
        for i in items:
            name=i.filename.replace('\\','/')
            path=Path(name)
            if not name or path.is_absolute() or '..' in path.parts or re.match(r'^[A-Za-z]:',name):raise ValueError('مسیر ناامن در ZIP')
            if name in names:raise ValueError('مسیر تکراری در ZIP')
            names.add(name)
            if (i.external_attr>>16)&0o170000 == 0o120000:raise ValueError('فایل symlink در ZIP قابل پذیرش نیست.')
            if i.file_size>MAX_FILE or (i.compress_size==0 and i.file_size>0) or (i.compress_size>0 and i.file_size/i.compress_size>10000):raise ValueError('ورودی فشرده‌شده مشکوک')
        for i in items:
            path=target/i.filename
            if i.is_dir():path.mkdir(parents=True,exist_ok=True);continue
            path.parent.mkdir(parents=True,exist_ok=True)
            with z.open(i) as inp,path.open('wb') as out:shutil.copyfileobj(inp,out,1024*1024)


def images_index(root):
    index=collections.defaultdict(list)
    for p in root.rglob('*'):
        if not p.is_file() or not p.resolve().is_relative_to(root.resolve()) or p.suffix.lower() not in IMAGE_EXT:continue
        if p.stat().st_size>17*1024*1024:continue
        rel=p.relative_to(root)
        if len(rel.parts)>12:continue
        index[label(p.name)].append(p)
    return index


def resolve_cover(book,root,images):
    value=str(book.get('cover') or '').split('?',1)[0].split('#',1)[0].replace('\\','/').strip()
    paths=[]
    if value:
        if '://' in value:value=value.rsplit('/',1)[-1] # only basename; never network downloads
        rel=Path(value.lstrip('/'))
        if not '..' in rel.parts:
            paths.extend([root/rel,root/'varaq'/rel,root/'public'/rel,root/'varaq'/'public'/rel])
            paths.extend(images.get(label(rel.name),[]))
    bookid=book.get('source_id','')
    if not paths and bookid:
        # Resolve only a uniquely matching filename, never guess among multiple editions.
        matches=[]
        for stem in (str(bookid),f'book-{bookid}',f'book_{bookid}',f'cover-{bookid}',f'cover_{bookid}'):
            for ext in IMAGE_EXT:matches.extend(images.get(label(stem+ext),[]))
        if len(matches)==1:paths=matches
    for p in paths:
        try:
            if not p.is_file() or not p.resolve().is_relative_to(root.resolve()) or p.suffix.lower() not in IMAGE_EXT:continue
            b=p.read_bytes()
            valid=(p.suffix.lower()=='.png' and b.startswith(b'\x89PNG\r\n\x1a\n')) or (p.suffix.lower() in {'.jpg','.jpeg'} and b.startswith(b'\xff\xd8\xff')) or (p.suffix.lower()=='.webp' and b.startswith(b'RIFF') and b[8:12]==b'WEBP')
            if valid:return p,b
        except OSError:pass
    return None,None


def brief(book):
    def to_price(x):
        try:return max(0,min(int(float(str(x).replace(',','').replace('٬','') or '0')),2_000_000_000))
        except (ValueError,TypeError):return 0
    return (book['title'][:240],book['author'][:180],book['publisher'][:180],book['isbn'][:30],book['year'][:15],book['category'][:75],book['description'][:9000],to_price(book.get('price')),to_price(book.get('stock')))


def perform(root,expected=1000,shop_id=1,apply=False,source_sha256=None):
    books,sources,source_rows=merge_records(root)
    idx=images_index(root)
    resolved=[]
    for b in books:
        p,raw=resolve_cover(b,root,idx)
        resolved.append((b,p,raw))
    n_cover=sum(x[2] is not None for x in resolved)
    n_desc=sum(len(x[0].get('description','').strip())>15 for x in resolved)
    unique_cover_hashes={hashlib.sha256(raw).hexdigest() for b,path,raw in resolved if raw is not None}
    unique_summary_texts={re.sub(r'\s+',' ',label(b.get('description',''))) for b,path,raw in resolved
                          if len(b.get('description','').strip())>15}
    media_bytes=sum(len(raw) for b,path,raw in resolved if raw is not None)
    incomplete=[{'title':b['title'][:100],'missing_cover':raw is None,'missing_summary':len(b.get('description','').strip())<=15}
                for b,path,raw in resolved if raw is None or len(b.get('description','').strip())<=15]
    report={'version':'9.5','source_files':sources,'source_rows':source_rows,'unique_books':len(books),
            'covers_recognized':n_cover,'summaries_recognized':n_desc,
            'distinct_cover_files':len(unique_cover_hashes),'distinct_summaries':len(unique_summary_texts),
            'uncompressed_cover_bytes':media_bytes,
            'complete_book_records':len(books)-len(incomplete),'incomplete_count':len(incomplete),
            'incomplete_sample':incomplete[:30],'source_sha256':source_sha256,'target_shop_id':shop_id,
            'expected_books':expected,'books_sample':[x[0]['title'] for x in resolved[:12]],'status':'not_applied'}
    if len(books)<expected:
        report['status']='insufficient_records'
        report['error']=f'فقط {len(books)} کتاب قابل خواندن است و حداقل {expected} عنوان لازم است. داده ناقص اعمال نمی‌شود.'
        return report
    if incomplete:
        report['status']='incomplete_media_or_summaries'
        report['error']=(f'{len(incomplete)} کتاب از {len(books)} عنوان شناسایی‌شده فاقد جلد یا خلاصه معتبر است؛ '
                         'برای جلوگیری از ثبت ادغام ناقص، هیچ تغییری اعمال نشد.')
        return report
    if len(unique_cover_hashes)<expected:
        report.update(status='reused_covers',error=(f'فقط {len(unique_cover_hashes)} تصویر جلد متفاوت برای حداقل {expected} کتاب وجود دارد؛ '
                                                  'تا زمان بازبینی، این انتقال کامل تلقی نمی‌شود.'))
        return report
    if len(unique_summary_texts)<expected:
        report.update(status='repeated_summaries',error=(f'فقط {len(unique_summary_texts)} معرفی متنی متفاوت برای حداقل {expected} کتاب شناسایی شد.'))
        return report
    if media_bytes>300*1024*1024:
        report.update(status='media_too_large',error='حجم خام جلدها بیش از ۳۰۰ مگابایت است؛ برای کنترل مصرف حافظه ابتدا تصاویر را بهینه کنید.')
        return report
    if not apply:return report
    app.init()
    with app.db() as c:
        if not c.execute('SELECT 1 FROM shops WHERE id=?',(shop_id,)).fetchone():
            report['status']='target_shop_missing';report['error']='فروشگاه مقصد وجود ندارد؛ ابتدا INSTALL_AND_RUN را اجرا کنید.';return report
    backup_folder=app.ROOT/'backups';backup_folder.mkdir(exist_ok=True)
    stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    backup=backup_folder/f'before_merge_v86_{stamp}_{os.getpid()}.sqlite3'
    with app.db() as original, sqlite3.connect(backup) as bkp:original.backup(bkp)
    report['backup_database']=str(backup.relative_to(app.ROOT))
    with backup.open('rb') as backup_stream:
        report['backup_sha256']=hashlib.file_digest(backup_stream,'sha256').hexdigest()
    copied=0;inserted=0;enriched=0;duplicates=0;media_cache={};created_files=[]
    try:
        with app.db() as c:
            c.execute('BEGIN IMMEDIATE')
            for book,path,raw in resolved:
                title,author,publisher,isbn,year,category,description,price,stock=brief(book)
                if not title:continue
                cur=c.execute('SELECT * FROM books WHERE shop_id=? AND isbn=? LIMIT 1',(shop_id,isbn)).fetchone() if isbn else None
                if not cur:
                    # Match a title only when ISBN and author are compatible. A
                    # different edition with a different ISBN must be retained.
                    # One already-edited record with blank ISBN can be enriched,
                    # without changing its other manually edited values.
                    candidates=c.execute('''SELECT * FROM books WHERE shop_id=? AND title=?
                       AND (isbn=? OR isbn='' OR ?='') ORDER BY id LIMIT 100''',
                       (shop_id,title,isbn,isbn)).fetchall()
                    exact=[candidate for candidate in candidates if candidate['author']==author and
                           (not candidate['isbn'] or candidate['isbn']==isbn)]
                    if len(exact)==1:
                        cur=exact[0]
                    elif len(candidates)==1:
                        candidate=candidates[0]
                        if (not candidate['author'] or candidate['author']==author or
                                (bool(isbn) and not candidate['isbn'])):
                            cur=candidate
                cover=''
                if raw:
                    # In the combined release reuse the 1000 original concept-art
                    # files in place. Do not duplicate ~25MB of images in ZIP.
                    same_legacy=(path.resolve().parent==app.LEGACY_COVERS.resolve() and
                                 re.fullmatch(r'book-\d{3,4}\.webp',path.name))
                    if same_legacy:
                        cover='v86_'+path.name
                    else:
                        checksum=hashlib.sha256(raw).hexdigest()
                        if checksum not in media_cache:
                            ext=path.suffix.lower();name='v86_'+checksum[:28]+ext
                            dest=app.COVERS/name
                            if not dest.exists():
                                tmp=app.COVERS/('.tmp_'+secrets.token_hex(12))
                                try:
                                    tmp.write_bytes(raw)
                                    os.replace(tmp,dest)
                                    created_files.append(dest);copied+=1
                                finally:tmp.unlink(missing_ok=True)
                            media_cache[checksum]=name
                        cover=media_cache[checksum]
                if cur:
                    # Existing fields are sacred, only missing covers/descriptions are filled.
                    updates={}
                    if not cur['cover'] and cover:updates['cover']=cover
                    if not cur['description'] and description:updates['description']=description
                    for col,val in (('author',author),('publisher',publisher),('isbn',isbn),('year',year)):
                        if not cur[col] and val:updates[col]=val
                    if updates:
                        q=', '.join(k+'=?' for k in updates)
                        c.execute(f'UPDATE books SET {q},updated=? WHERE id=?',list(updates.values())+[app.now(),cur['id']])
                        enriched+=1
                    else:duplicates+=1
                else:
                    c.execute('''INSERT INTO books(shop_id,title,author,publisher,isbn,year,category,description,price,stock,kind,cover,ebook,rights_ok,slug,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                        (shop_id,title,author,publisher,isbn,year,category,description,price,stock,'physical',cover,'',0,app.slug(title),'active',app.now(),app.now()))
                    inserted+=1
            final=c.execute('SELECT COUNT(*) FROM books WHERE shop_id=?',(shop_id,)).fetchone()[0]
        report.update({'status':'applied','inserted':inserted,'enriched':enriched,'unchanged':duplicates,
                       'new_cover_files':copied,'final_shop_book_count':final,'applied_at':app.now()})
    except Exception:
        for created_file in created_files:
            try:created_file.unlink(missing_ok=True)
            except OSError:pass
        report.update({'status':'failed_rolled_back','error':'ادغام شکست خورد؛ دیتابیس در تراکنش به حالت قبل بازگشت. نسخه پشتیبان موجود است.'})
        raise
    if report['status']=='applied':
        report_file=app.DATA/'last_merge_v86_report.json'
        staging=report_file.with_name(report_file.name+'.tmp')
        staging.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        os.replace(staging,report_file)
    return report


def cli(argv=None):
    p=argparse.ArgumentParser(description='Safe and verifiable VARAQ 8.6 -> 9.4 catalog merge')
    p.add_argument('source',help='Legacy archive .zip or extracted project directory')
    p.add_argument('--shop-id',type=int,default=1)
    p.add_argument('--expected',type=int,default=1000,help='Minimum unique titles needed for merge (default 1000)')
    p.add_argument('--apply',action='store_true',help='Apply after verification and database backup')
    p.add_argument('--dry-run',action='store_true',help='Legacy alias: inspect only, no writes')
    p.add_argument('--report',help='Optional JSON report file')
    args=p.parse_args(argv)
    source=Path(args.source).expanduser().resolve()
    if not source.exists():p.error('Legacy source not found')
    if args.expected<1 or args.shop_id<1:p.error('Invalid expected/shop-id')
    source_hash=None
    if source.is_file():
        with source.open('rb') as fh:source_hash=hashlib.file_digest(fh,'sha256').hexdigest()
    def run(folder):return perform(folder,args.expected,args.shop_id,args.apply and not args.dry_run,source_hash)
    if source.is_file() and zipfile.is_zipfile(source):
        with tempfile.TemporaryDirectory(prefix='varaq_v86_') as tmp:
            zip_to_dir(source,Path(tmp));report=run(Path(tmp))
    elif source.is_dir():report=run(source)
    else:p.error('Need a ZIP or extracted source directory')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    if args.report:Path(args.report).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return 0 if report['status'] in ('not_applied','applied') else 2

if __name__=='__main__':sys.exit(cli())
