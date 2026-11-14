#!/usr/bin/env python3
"""Validate installed images, seal portable receipts, and record resumable progress."""
from pathlib import Path
from PIL import Image
import json, hashlib, html
ROOT=Path(__file__).resolve().parents[1]
books=json.loads((ROOT/'data/books.json').read_text())
done=[]; pending=[]; records=[]
for b in books:
    name=f"book-{b['id']:03d}"
    receipt=ROOT/'data/ai-cover-progress'/f'{name}.json'
    if not receipt.exists():
        pending.append({'id':b['id'],'title':b['title'],'author':b.get('author',''),'category':b['category']})
        continue
    r=json.loads(receipt.read_text())
    assert (r['id'],r['title'])==(b['id'],b['title']),name
    cover=ROOT/'public/concept-art'/f'{name}.webp'
    thumb=ROOT/'public/concept-thumb'/f'{name}.webp'
    # The server's image validator caps each cover at 700 KiB.
    if cover.stat().st_size>700*1024:
        with Image.open(cover) as original:
            pixels=original.convert('RGB')
        for quality in [88,86,84,82,80,76,72]:
            pixels.save(cover,quality=quality)
            if cover.stat().st_size<=700*1024:
                r['webp_quality_after_size_optimization']=quality
                break
        assert cover.stat().st_size<=700*1024,('cover exceeds server limit',name)
    for f,size in [(cover,(1000,1400)),(thumb,(240,336))]:
        with Image.open(f) as im:
            im.load()
            assert im.format=='WEBP' and im.size==size,(str(f),im.size)
    r['sha256']=hashlib.sha256(cover.read_bytes()).hexdigest()
    r['thumbnail_sha256']=hashlib.sha256(thumb.read_bytes()).hexdigest()
    r['generator']='built-in image_gen'
    r['status']='generated_installed_awaiting_visual_review'
    r['image']=str(cover.relative_to(ROOT))
    r['thumbnail']=str(thumb.relative_to(ROOT))
    r.pop('source',None)
    receipt.write_text(json.dumps(r,ensure_ascii=False,indent=2))
    done.append(b['id']);records.append(r)
assert len({r['sha256'] for r in records})==len(records),'duplicate artwork'
report={'release':'9.8.9','total_books':len(books),'new_images_generated_and_installed':len(done),'completed_book_ids':done,'remaining_count':len(pending),'remaining_books':pending,'technical_validation':'passed','visual_review':'pending; generation is not a claim of human approval','publisher_cover':False,'records':records}
(ROOT/'data/AI_COVER_PROGRESS_V989.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
cards=''.join(f'<figure><img loading="lazy" src="../{r["thumbnail"]}"><figcaption>{r["id"]} · {html.escape(r["title"])}</figcaption></figure>' for r in records)
(ROOT/'docs/AI_COVER_GALLERY_V989.html').write_text('<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>تصاویر تازه ورق</title><style>body{font:16px Tahoma;background:#faf7f1;color:#25332f;margin:24px}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:18px}figure{margin:0}img{width:100%;aspect-ratio:5/7;object-fit:cover;border-radius:12px}figcaption{padding:10px}</style><h1>تصاویر اختصاصی تازه ورق</h1><p>'+str(len(done))+' از '+str(len(books))+' تصویر جدید ساخته و نصب شده است. این تصاویر جلد ناشر نیستند؛ بررسی بصری نهایی هنوز ثبت نشده است.</p><main>'+cards+'</main></html>')
print(json.dumps({'completed':len(done),'remaining':len(pending),'technical_validation':'passed'}))
