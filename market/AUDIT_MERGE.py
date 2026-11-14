#!/usr/bin/env python3
"""Read-only audit of target catalog and migration state, no PII included."""
import json, sys, sqlite3
import app

def audit():
    if not app.DB.exists():
        print(json.dumps({'status':'no_database'},ensure_ascii=False))
        return 2
    with app.db() as c:
        books=c.execute('SELECT id,title,cover,description FROM books ORDER BY id').fetchall()
        db_ok=c.execute('PRAGMA integrity_check').fetchone()[0]
        users=c.execute('SELECT count(*) FROM users').fetchone()[0]
        orders=c.execute('SELECT count(*) FROM orders').fetchone()[0]
        missing_images=[];missing_descriptions=[]
        for b in books:
            if not b['cover'] or not (app.COVERS/b['cover']).is_file():missing_images.append(b['id'])
            if len(b['description'].strip())<=15:missing_descriptions.append(b['id'])
    report_file=app.DATA/'last_merge_v86_report.json'
    try:last=json.loads(report_file.read_text(encoding='utf-8')) if report_file.exists() else None
    except (ValueError,OSError):last=None
    result={'database_integrity':db_ok,'book_count':len(books),'covers_present':len(books)-len(missing_images),'summaries_present':len(books)-len(missing_descriptions),'missing_cover_book_ids':missing_images[:30],'missing_summary_book_ids':missing_descriptions[:30],'accounts_preserved_count':users,'orders_preserved_count':orders,'migration_status':last['status'] if last else 'no_verified_migration'}
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0 if db_ok=='ok' and result['migration_status']=='applied' and len(books)>=1000 and not missing_images and not missing_descriptions else 2

if __name__=='__main__':sys.exit(audit())
