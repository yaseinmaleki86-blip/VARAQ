#!/usr/bin/env python3
"""Local-only, independent HTTP acceptance smoke for both web backends."""
import subprocess,sys,os,time,urllib.request,tempfile
from pathlib import Path
root=Path(__file__).resolve().parent.parent;market=root/'market'
py=subprocess.Popen([sys.executable,'-u','-c',"import app; from http.server import ThreadingHTTPServer; ThreadingHTTPServer(('127.0.0.1',18875),app.Site).serve_forever()"],cwd=market,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
with tempfile.TemporaryDirectory(prefix='varaq-v95-smoke-') as t:
    env=dict(os.environ,PORT='13303',HOST='127.0.0.1',DATA_DIR=t)
    node=subprocess.Popen(['node','server.js'],cwd=root,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        tests=[('market home','http://127.0.0.1:18875/',b'<html'),('market books','http://127.0.0.1:18875/books',b'<!doctype'),('market detail','http://127.0.0.1:18875/book/1','ملت عشق'.encode()),('market cover','http://127.0.0.1:18875/covers/v86_book-001.webp',b'RIFF'),('legacy home','http://127.0.0.1:13303/','ورق'.encode()),('legacy books','http://127.0.0.1:13303/books','کتاب'.encode()),('legacy cover','http://127.0.0.1:13303/concept-art/book-001.webp',b'RIFF')]
        for name,url,sample in tests:
            for retry in range(50):
                try:
                    with urllib.request.urlopen(url,timeout=4) as response:
                        assert response.status==200
                        data=response.read(160000)
                        assert sample in data,name
                        print('PASS',name,len(data))
                    break
                except Exception as e:
                    if retry==49:raise RuntimeError(f'{name}: {e}')
                    time.sleep(.25)
    finally:
        for proc in (node,py):
            proc.terminate()
            try:proc.wait(timeout=5)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()
print('PASS all 7 HTTP integration checks')
