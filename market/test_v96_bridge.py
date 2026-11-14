#!/usr/bin/env python3
"""Security + store isolation unit tests for the 9.6 bridge. No real accounts used."""
import tempfile,shutil,os,sys,importlib.util,base64,hmac,hashlib,json,time
from pathlib import Path
with tempfile.TemporaryDirectory(prefix='varaq96_bridge_') as t:
    work=Path(t)
    shutil.copy2(Path(__file__).with_name('app.py'),work/'app.py')
    os.environ['VARAQ_BRIDGE_SECRET']='ee'*32
    try:
        spec=importlib.util.spec_from_file_location('test_bridge_app',work/'app.py')
        app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)
        app.init()
        with app.db() as c:
            c.execute('INSERT INTO shops(id,name,slug,description) VALUES(1,?,?,?)',('فروشگاه اصلی','varaq',''))
            c.execute('INSERT INTO shops(id,name,slug,description) VALUES(2,?,?,?)',('فروشگاه دوم','second',''))
            c.execute('INSERT INTO users(username,passhash,role,created) VALUES(?,?,?,?)',('old_owner',app.hashpass('veryStrongOldOwnerPassword'), 'seller',app.now()))
            c.execute('UPDATE shops SET owner_id=(SELECT id FROM users WHERE username=?) WHERE id=1',('old_owner',))
            old_owner=c.execute('SELECT owner_id FROM shops WHERE id=1').fetchone()['owner_id']
        claim={'id':44,'name':'manager44','role':'seller','store_id':1,'store_name':'فروشگاه اصلی','permission':'manager','ts':int(time.time()),'nonce':'beadbabe'}
        raw=base64.urlsafe_b64encode(json.dumps(claim).encode()).decode().rstrip('=')
        mac=hmac.new(bytes.fromhex(app.BRIDGE_SECRET),raw.encode(),hashlib.sha256).hexdigest()
        signed=raw+'.'+mac
        assert app.bridge_claim({'X-Varaq-Bridge':signed},'127.0.0.1')==claim
        assert app.bridge_claim({'X-Varaq-Bridge':signed+'abc'},'127.0.0.1') is None
        assert app.bridge_claim({'X-Varaq-Bridge':signed},'8.8.8.8') is None
        old=claim.copy();old['ts']-=5000
        raw2=base64.urlsafe_b64encode(json.dumps(old).encode()).decode().rstrip('=')
        assert app.bridge_claim({'X-Varaq-Bridge':raw2+'.'+hmac.new(bytes.fromhex(app.BRIDGE_SECRET),raw2.encode(),hashlib.sha256).hexdigest()},'127.0.0.1') is None
        with app.db() as c:
            uid=app.bridge_user(c,claim)
            assert app.bridge_user(c,claim)==uid
            assert c.execute('SELECT owner_id FROM shops WHERE id=1').fetchone()['owner_id']==old_owner,'SSO changed original owner!'
            assert c.execute('SELECT bridge_store_id FROM users WHERE id=?',(uid,)).fetchone()[0]==1
            c.execute('UPDATE shops SET bridge_store_id=2 WHERE id=2')
            u=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
            fake=type('Fake',(),{'user':u,'user_id':uid})()
            ids=app.Site.seller_shopids(fake,c)
            assert ids==[1],ids
            other=claim|{'id':45,'store_id':2,'name':'manager45'}
            u2=app.bridge_user(c,other)
            fake=type('Fake',(),{'user':c.execute('SELECT * FROM users WHERE id=?',(u2,)).fetchone(),'user_id':u2})()
            assert app.Site.seller_shopids(fake,c)==[2]
        print('PASS v9.6: HMAC, tampering, loopback-only, timestamp, stable mapping, original ownership, seller isolation')
    finally:os.environ.pop('VARAQ_BRIDGE_SECRET',None)
