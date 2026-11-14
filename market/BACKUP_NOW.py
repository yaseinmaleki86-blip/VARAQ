"""Make an online-consistent SQLite backup and optional media archive."""
import app, datetime, sqlite3, shutil, zipfile
from pathlib import Path
app.init()
folder=app.ROOT/'backups';folder.mkdir(exist_ok=True)
stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
destination=folder/('VARAQ_backup_'+stamp+'.zip')
snapshot=folder/('snapshot_'+stamp+'.sqlite3')
with app.db() as source,sqlite3.connect(snapshot) as target:source.backup(target)
with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    z.write(snapshot,'data/varaq.sqlite3')
    for directory,label in ((app.COVERS,'assets/covers'),(app.EBOOKS,'private/books')):
        for p in directory.glob('*'):
            if p.is_file():z.write(p, label+'/'+p.name)
snapshot.unlink()
print('Backup saved:',destination)
print('WARNING: Private PDFs and customer personal data may be present; encrypt before sharing.')
