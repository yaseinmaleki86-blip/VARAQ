#!/usr/bin/env python3
"""One-command local launcher for one-origin VARAQ v9.7, with private per-run SSO key."""
from pathlib import Path
import os,sys,subprocess,secrets,time,urllib.request,signal,webbrowser
ROOT=Path(__file__).resolve().parent.parent
MARKET=ROOT/'market'

def ready(url):
    try:
        with urllib.request.urlopen(url, timeout=0.6) as response:
            return response.status==200
    except Exception:return False

def main():
    if sys.version_info < (3,10): raise SystemExit('Python 3.10+ required')
    try:
        ver=subprocess.run(['node','--version'],capture_output=True,text=True,timeout=4,check=True).stdout.strip()
        nums=tuple(int(x) for x in ver.lstrip('v').split('.')[:3])
        if nums<(22,13):raise RuntimeError('Node.js 22.13 or newer required')
    except Exception as e:raise SystemExit('Node.js 22.13+ required: '+str(e))
    port=int(os.environ.get('PORT','3030'));mp=int(os.environ.get('VARAQ_MARKET_PORT','8765'))
    if not 1024<=port<=65535 or not 1024<=mp<=65535 or port==mp:
        raise SystemExit('Invalid or duplicated local server ports')
    if os.environ.get('PUBLIC_URL'):
        raise SystemExit('This local unified launcher cannot enable public checkout. Use the audited public-readonly procedure.')
    if ready(f'http://127.0.0.1:{mp}/health') or ready(f'http://127.0.0.1:{port}/health'):
        raise SystemExit('A VARAQ instance is already running on the configured port. Stop it first.')
    marker=MARKET/'data'/'.catalog_identity_ready'
    marker.unlink(missing_ok=True)
    secret=secrets.token_hex(32)
    env=dict(os.environ,VARAQ_BRIDGE_SECRET=secret,VARAQ_CATALOG_LINK_PENDING='1',VARAQ_MARKET_PORT=str(mp),VARAQ_PORT=str(mp),VARAQ_HOST='127.0.0.1',
             HOST='127.0.0.1',PORT=str(port),VARAQ_PUBLIC_URL=f'http://127.0.0.1:{port}')
    env.pop('PUBLIC_URL',None)
    print('Starting local retail backend (private loopback)...',flush=True)
    retail=subprocess.Popen([sys.executable,'-u','app.py','--serve','--host','127.0.0.1','--port',str(mp)],cwd=MARKET,env=env)
    node=None
    try:
        for _ in range(70):
            if retail.poll() is not None:raise RuntimeError('Retail backend exited early')
            if ready(f'http://127.0.0.1:{mp}/health'):break
            time.sleep(.15)
        else:raise RuntimeError('Retail backend did not start')
        print('Starting main VARAQ website...',flush=True)
        node=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env)
        for _ in range(70):
            if node.poll() is not None:raise RuntimeError('Node website exited early')
            if ready(f'http://127.0.0.1:{port}/market/health'):break
            time.sleep(.15)
        else:raise RuntimeError('Gateway did not start')
        # Only bibliographic identity is joined; orders and stock remain retail-owned.
        # The Node database has been initialized by this point.
        legacy_db=Path(os.environ.get('DATA_DIR',str(ROOT/'storage')))/'varaq.sqlite'
        map_command=[sys.executable,'CATALOG_LINK_V98.py','--node-db',str(legacy_db),
                     '--retail-db',str(MARKET/'data'/'varaq.sqlite3'),
                     '--out-dir',str(MARKET/'data'/'reports'),'--apply']
        result=subprocess.run(map_command,cwd=MARKET,env=env,text=True,capture_output=True,timeout=90)
        if result.returncode!=0:
            raise RuntimeError('Catalog link verification failed: '+result.stderr.strip()[-900:])
        marker.parent.mkdir(parents=True,exist_ok=True)
        tempmarker=marker.with_name('.catalog_identity_ready.tmp')
        tempmarker.write_text('ready',encoding='ascii')
        os.replace(tempmarker,marker)
        print('Catalog identity mapping verified (no financial records transferred).',flush=True)
        print('✅ VARAQ unified: http://127.0.0.1:'+str(port)+'/',flush=True)
        print('✅ Store and checkout: http://127.0.0.1:'+str(port)+'/market/',flush=True)
        print('Use the original /login for store owners; customer registration is inside /market/register.',flush=True)
        print('Closing this console will request both processes to exit.',flush=True)
        if os.environ.get('VARAQ_OPEN_BROWSER')=='1':webbrowser.open(f'http://127.0.0.1:{port}/')
        while True:
            if node.poll() is not None or retail.poll() is not None:
                raise RuntimeError('One of the site services has stopped')
            time.sleep(.5)
    except KeyboardInterrupt:
        print('Stopping VARAQ...',flush=True)
    finally:
        for proc in (node,retail):
            if proc is None or proc.poll() is not None:continue
            proc.terminate()
        for proc in (node,retail):
            if proc is None or proc.poll() is not None:continue
            try:proc.wait(timeout=7)
            except subprocess.TimeoutExpired:
                proc.kill();proc.wait()

if __name__=='__main__':main()
