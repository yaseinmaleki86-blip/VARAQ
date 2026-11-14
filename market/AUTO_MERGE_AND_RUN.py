#!/usr/bin/env python3
"""One-click local archive discovery + safe merge + normal server startup."""
from pathlib import Path
import json, sys, getpass, hashlib
import app
from PRESERVE_V91 import copy_existing_state
from MERGE_V86 import cli, perform, zip_to_dir
import tempfile

ROOT=Path(__file__).resolve().parent
SEARCH_DIRS=[ROOT,ROOT.parent,ROOT/'legacy',ROOT/'old',Path.home()/'Downloads']
CANDIDATE_GLOB='VARAQ_Book_Market_v8.6*Full_Source*.zip'

def find_old_zip():
    paths={p.resolve() for folder in SEARCH_DIRS if folder.exists() for p in folder.glob(CANDIDATE_GLOB) if p.is_file()}
    if len(paths)>1:
        print('WARNING: multiple legacy ZIPs found. Keep only the desired ZIP beside the installer; no automatic choice will be made.')
        return None
    return max(paths,key=lambda p:p.stat().st_mtime) if paths else None

def main():
    print('VARAQ 9.4 | safe catalog merge + launch')
    adoption=copy_existing_state()
    if adoption['status'] in ('adopted_v91','adopted_v92','adopted_v93'):
        print('Existing v9.x data, accounts, orders, and media preserved:',adoption['copied_media_files'],'files')
    app.init()
    with app.db() as conn:has_admin=conn.execute("SELECT 1 FROM users WHERE role='admin'").fetchone()
    if not has_admin:
        print('Create a local admin for this independent store. No old login credentials will be imported.')
        user=input('Admin username: ').strip()
        pw=getpass.getpass('New password (12+ characters): ')
        app.setup_admin(user,pw)
    source=find_old_zip()
    if not source:
        print('Legacy 8.6 ZIP not found locally. No data merge was performed.')
        print('Place original ZIP beside MERGE_AND_RUN.bat, then launch again to merge.')
    else:
        print('Legacy file:',source.name)
        with source.open('rb') as stream:source_hash=hashlib.file_digest(stream,'sha256').hexdigest()
        statefile=app.DATA/'last_merge_v86_report.json'
        try:state=json.loads(statefile.read_text(encoding='utf-8')) if statefile.exists() else {}
        except (OSError,ValueError):state={}
        if (state.get('status')=='applied' and state.get('source_sha256')==source_hash
                and state.get('target_shop_id')==1 and state.get('final_shop_book_count',0)>=1000):
            print('This exact source archive has already been merged successfully; skipping duplicate import and backup.')
        else:
            with tempfile.TemporaryDirectory(prefix='varaq_v86_automerge_') as tmp:
                zip_to_dir(source,Path(tmp))
                report=perform(Path(tmp),expected=1000,shop_id=1,apply=False,source_sha256=source_hash)
                print('Dry-run: found',report['unique_books'],'titles,',report['covers_recognized'],'covers,',report['summaries_recognized'],'descriptions')
                if report['status']!='not_applied':print('Merge not applied:',report['error'])
                else:
                    done=perform(Path(tmp),expected=1000,shop_id=1,apply=True,source_sha256=source_hash)
                    if done['status']=='applied':
                        print('Merge successful. Added:',done['inserted'],'Enriched:',done['enriched'],'Total:',done['final_shop_book_count'])
                        print('Backup:',done.get('backup_database',''))
                    else:print('Merge not applied:',done.get('error',done['status']))
    print('Launching store on http://127.0.0.1:'+str(app.PORT))
    sys.argv=[sys.argv[0],'--serve']
    app.main()

if __name__=='__main__':main()
