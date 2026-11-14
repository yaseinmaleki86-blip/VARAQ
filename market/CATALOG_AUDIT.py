#!/usr/bin/env python3
"""Read-only book-catalog integrity report, safe for the admin dashboard.
No personal/customer data appears in the report.
"""
import json, sqlite3, re
from collections import Counter
from pathlib import Path
import app


def report():
    if not app.DB.exists():
        return {'status':'database_missing', 'database_integrity':None}
    with app.db() as c:
        integrity=c.execute('PRAGMA integrity_check').fetchone()[0]
        rows=c.execute('''SELECT b.id,b.shop_id,b.title,b.isbn,b.cover,b.description,
                                 b.kind,b.ebook,b.rights_ok,b.stock,b.price,b.status,
                                 s.name shop_name,s.active shop_active
                          FROM books b JOIN shops s ON b.shop_id=s.id ORDER BY b.id''').fetchall()
    missing_covers=[];short_summaries=[];missing_pdf=[];invalid_sale=[];per_shop=Counter();seen_isbn={};dupe_isbn=[]
    for r in rows:
        id_=r['id'];per_shop[str(r['shop_id'])+' · '+r['shop_name']]+=1
        name=r['cover'] or ''
        if not re.fullmatch(r'[A-Za-z0-9_.-]+',name) or not (app.COVERS/name).is_file():
            missing_covers.append(id_)
        if len((r['description'] or '').strip())<=15:short_summaries.append(id_)
        if r['kind'] in ('pdf','both'):
            ebook=r['ebook'] or ''
            if not (r['rights_ok'] and re.fullmatch(r'[A-Za-z0-9_-]+\.pdf',ebook) and (app.EBOOKS/ebook).is_file()):
                missing_pdf.append(id_)
        if r['price']<0 or r['stock']<0:invalid_sale.append(id_)
        isbn=(r['isbn'] or '').strip()
        if isbn:
            key=(r['shop_id'],isbn)
            if key in seen_isbn:dupe_isbn.append([seen_isbn[key],id_])
            else:seen_isbn[key]=id_
    report_file=app.DATA/'last_merge_v86_report.json'
    try:legacy=json.loads(report_file.read_text(encoding='utf-8')) if report_file.is_file() else None
    except (OSError,ValueError):legacy=None
    has_data=bool(rows)
    state='needs_attention' if missing_covers or short_summaries or missing_pdf or dupe_isbn or integrity!='ok' else ('healthy' if has_data else 'empty')
    return {'status':state,'database_integrity':integrity,'book_count':len(rows),
            'covers_present':len(rows)-len(missing_covers),'summaries_present':len(rows)-len(short_summaries),
            'missing_cover_count':len(missing_covers),'missing_summary_count':len(short_summaries),
            'missing_pdf_or_rights_count':len(missing_pdf),'duplicate_isbn_count':len(dupe_isbn),
            'invalid_price_stock_count':len(invalid_sale),'shops':dict(per_shop),
            'samples':{'missing_cover_ids':missing_covers[:25], 'short_summary_ids':short_summaries[:25],
                       'invalid_pdf_ids':missing_pdf[:25], 'duplicate_isbn_pairs':dupe_isbn[:10]},
            'legacy_merge':{'status':legacy.get('status'),'source_sha256':legacy.get('source_sha256'),
                            'applied_at':legacy.get('applied_at'),'inserted':legacy.get('inserted')}
                             if isinstance(legacy,dict) else None}


if __name__=='__main__':
    print(json.dumps(report(),ensure_ascii=False,indent=2))
