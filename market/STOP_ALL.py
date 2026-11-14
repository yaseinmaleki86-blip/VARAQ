from pathlib import Path
import urllib.request
import os
port=os.environ.get('VARAQ_PORT','8765')
token=Path(__file__).resolve().parent/'data'/'stop.token'
if not token.exists():
    print('No running VARAQ instance detected.')
else:
    req=urllib.request.Request('http://127.0.0.1:'+port+'/internal/stop',data=b'',headers={'X-Stop-Token':token.read_text()},method='POST')
    try:
        with urllib.request.urlopen(req,timeout=4) as r: print('Stop requested:',r.read().decode())
    except Exception as e: print('Could not stop the server:',e)
