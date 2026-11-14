#!/usr/bin/env python3
"""Atomic, read-only adoption of a neighboring v9.3/v9.2/v9.1 store's accounts/orders/media.
Legacy v8.6 Node.js storage is not supported by this Python v9.x copy tool.
"""
from pathlib import Path
import sqlite3, shutil, os, hashlib, json, secrets
import app

ROOT=Path(__file__).resolve().parent


def copy_existing_state():
    if app.DB.exists():return {'status':'target_database_exists','copied':0}
    # The last verified v9.x installation takes priority, with no merging of
    # two independent databases; only one source is read and it stays intact.
    candidates=[ROOT.parent/'VARAQ_Store_v9_3',ROOT.parent/'VARAQ_Store_v9.3',
                ROOT.parent/'VARAQ_Store_v9_2',ROOT.parent/'VARAQ_Store_v9.2',
                ROOT.parent/'VARAQ_Store_v9_1',ROOT.parent/'VARAQ_Store_v9.1',ROOT/'../old_v91']
    previous=next((p.resolve() for p in candidates if (p/'data'/'varaq.sqlite3').is_file()),None)
    if not previous:return {'status':'no_neighbor_v91','copied':0}
    if (previous/'data'/'stop.token').exists():
        raise RuntimeError('v9.1 may be running. Stop the old instance before copying its database.')
    srcdb=previous/'data'/'varaq.sqlite3'
    app.DATA.mkdir(parents=True,exist_ok=True)
    tempdb=app.DATA/('.adopt_'+secrets.token_hex(10)+'.sqlite3')
    staged=[];installed=[]
    try:
        with sqlite3.connect('file:'+str(srcdb)+'?mode=ro',uri=True) as src, sqlite3.connect(tempdb) as dest:
            src.backup(dest)
        with sqlite3.connect(tempdb) as check:
            integrity=check.execute('PRAGMA integrity_check').fetchone()[0]
            table_names={x[0] for x in check.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            required={'users','shops','books','orders','order_items','sessions'}
            if integrity!='ok' or not required.issubset(table_names):
                raise RuntimeError('Previous database is corrupted or lacks the expected v9.1 tables.')
        for group,folder in (('assets/covers',app.COVERS),('private/books',app.EBOOKS)):
            old=previous/group
            if not old.is_dir():continue
            folder.mkdir(parents=True,exist_ok=True)
            for child in old.iterdir():
                if not child.is_file() or child.is_symlink() or child.stat().st_size>100_000_000:continue
                # Restrict to expected filenames; never copy executable content.
                if group=='assets/covers':
                    if child.suffix.lower() not in ('.png','.jpg','.jpeg','.webp'):continue
                elif child.suffix.lower()!='.pdf':continue
                dest=folder/child.name
                if dest.exists():continue
                temp=folder/('.adopt_'+secrets.token_hex(10))
                shutil.copyfile(child,temp)
                staged.append((temp,dest))
        # Install media, then atomically publish the fully checked database.
        for temp,dest in staged:
            if dest.exists():temp.unlink(missing_ok=True);continue
            os.replace(temp,dest)
            installed.append(dest)
        if app.DB.exists():raise RuntimeError('Target database appeared during adoption; no overwrite performed.')
        os.replace(tempdb,app.DB)
        version=('v93' if '9_3' in previous.name or '9.3' in previous.name else
                 'v92' if '9_2' in previous.name or '9.2' in previous.name else 'v91')
        result={'status':'adopted_'+version,'copied_media_files':len(installed),'from':previous.name}
        # Preserve a verified merge receipt to avoid importing the same 8.6 archive again.
        receipt=previous/'data'/'last_merge_v86_report.json'
        if receipt.is_file() and receipt.stat().st_size<200_000:
            try:
                parsed=json.loads(receipt.read_text(encoding='utf-8'))
                if (isinstance(parsed,dict) and parsed.get('status')=='applied'
                    and isinstance(parsed.get('source_sha256'),str)
                    and len(parsed['source_sha256'])==64
                    and parsed.get('target_shop_id')==1):
                    tmp=app.DATA/('.receipt_'+secrets.token_hex(8))
                    tmp.write_text(json.dumps(parsed,ensure_ascii=False,indent=2),encoding='utf-8')
                    os.replace(tmp,app.DATA/'last_merge_v86_report.json')
                    result['merge_receipt_preserved']=True
            except (ValueError,OSError):pass
        (app.DATA/'previous_adoption_report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        return result
    except Exception:
        for temp,dest in staged:temp.unlink(missing_ok=True)
        for dest in installed:dest.unlink(missing_ok=True)
        raise
    finally:
        tempdb.unlink(missing_ok=True)


if __name__=='__main__':print(json.dumps(copy_existing_state(),ensure_ascii=False,indent=2))
