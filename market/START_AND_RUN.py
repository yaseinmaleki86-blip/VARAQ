from pathlib import Path
import getpass
import os
import sys
import app
from PRESERVE_V91 import copy_existing_state
result=copy_existing_state()
if result['status'].startswith('adopted_'):
    print('Existing installation safely imported:',result.get('from'))
app.init()
with app.db() as c:
    admin_exists=bool(c.execute("SELECT 1 FROM users WHERE role='admin' LIMIT 1").fetchone())
if not admin_exists:
    print('--- راه‌اندازی امن مدیریت ورق / Create administrator ---')
    user=input('Admin username: ').strip()
    password=getpass.getpass('Admin password (12+ characters): ')
    app.setup_admin(user,password)
    print('Admin created. Please keep credentials private.')
print('Browse to http://127.0.0.1:'+str(app.PORT))
sys.argv=[sys.argv[0],'--serve']
app.main()
