#!/usr/bin/env python3
"""Create a new administrator only if no admin exists; then start the retail server."""
import getpass,sys
import app
app.init()
with app.db() as db:
    admin=db.execute("SELECT id FROM users WHERE role='admin' LIMIT 1").fetchone()
if not admin:
    print('Create the retail-store admin. It is separate from legacy Node admin.')
    user=input('New admin username: ').strip()
    pw=getpass.getpass('Password (12+ characters): ')
    app.setup_admin(user,pw)
    print('Admin created successfully.')
sys.argv=['app.py','--serve']
app.main()
