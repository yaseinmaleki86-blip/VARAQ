#!/usr/bin/env python3
"""VARAQ independent retail feature core. Python stdlib only.
Run: python app.py --setup-admin USERNAME PASSWORD ; python app.py --serve
"""
import os, sys, re, json, csv, io, time, base64, shutil, secrets, hashlib, mimetypes, sqlite3, argparse, html, hmac, datetime, threading
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from email.parser import BytesParser
from email.policy import default

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
COVERS = ROOT / 'assets' / 'covers'
LEGACY_COVERS = ROOT.parent / 'public' / 'concept-art'
EBOOKS = ROOT / 'private' / 'books'
DB = DATA / 'varaq.sqlite3'
for d in (DATA,COVERS,EBOOKS): d.mkdir(parents=True,exist_ok=True)
HOST = os.environ.get('VARAQ_HOST', '127.0.0.1')
PORT = int(os.environ.get('VARAQ_PORT','8765'))
PUBLIC_URL = os.environ.get('VARAQ_PUBLIC_URL','http://localhost:'+str(PORT)).rstrip('/')
BRIDGE_SECRET = os.environ.get('VARAQ_BRIDGE_SECRET', '')
BRIDGE_ENABLED = bool(re.fullmatch(r'[a-fA-F0-9]{64,}', BRIDGE_SECRET))
BASE_PATH = '/market' if BRIDGE_ENABLED else ''
FREE_SHIPPING_FROM = 1_500_000
SHIPPING_PER_SHOP = 65_000
MAX_UPLOAD = 32 * 1024 * 1024

def H(s): return html.escape(str(s if s is not None else ''), quote=True)
def now(): return datetime.datetime.now().isoformat(timespec='seconds')
def money(x): return f'{int(x or 0):,}'.replace(',','٬') + ' تومان'
def slug(s):
    s=re.sub(r'[^\w\u0600-\u06ff -]+','',str(s).strip(),flags=re.UNICODE)
    return re.sub(r'\s+','-',s).strip('-')[:90] or secrets.token_hex(5)
def db():
    c=sqlite3.connect(DB,timeout=20)
    c.row_factory=sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    c.execute('PRAGMA busy_timeout=20000')
    return c

def init():
    with db() as c:
        c.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE,email TEXT,passhash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'customer',created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shops(id INTEGER PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,owner_id INTEGER REFERENCES users(id),description TEXT DEFAULT '',active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS books(id INTEGER PRIMARY KEY,shop_id INTEGER NOT NULL REFERENCES shops(id),title TEXT NOT NULL,author TEXT DEFAULT '',publisher TEXT DEFAULT '',isbn TEXT DEFAULT '',year TEXT DEFAULT '',category TEXT DEFAULT 'عمومی',description TEXT DEFAULT '',price INTEGER NOT NULL DEFAULT 0,stock INTEGER NOT NULL DEFAULT 0,kind TEXT NOT NULL DEFAULT 'physical',cover TEXT DEFAULT '',ebook TEXT DEFAULT '',rights_ok INTEGER DEFAULT 0,slug TEXT DEFAULT '',status TEXT DEFAULT 'active',created TEXT NOT NULL,updated TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),csrf TEXT NOT NULL,cart_json TEXT NOT NULL DEFAULT '{}',expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,code TEXT NOT NULL UNIQUE,user_id INTEGER REFERENCES users(id),recipient TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,subtotal INTEGER NOT NULL,discount INTEGER NOT NULL,shipping INTEGER NOT NULL,total INTEGER NOT NULL,payment_method TEXT NOT NULL,payment_status TEXT NOT NULL DEFAULT 'unpaid',created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id),shop_id INTEGER REFERENCES shops(id),book_id INTEGER REFERENCES books(id),title_snapshot TEXT NOT NULL,price INTEGER NOT NULL,qty INTEGER NOT NULL,kind TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shop_orders(order_id INTEGER REFERENCES orders(id),shop_id INTEGER REFERENCES shops(id),status TEXT NOT NULL DEFAULT 'new',PRIMARY KEY(order_id,shop_id));
        CREATE TABLE IF NOT EXISTS coupons(id INTEGER PRIMARY KEY,shop_id INTEGER REFERENCES shops(id),code TEXT NOT NULL UNIQUE,kind TEXT NOT NULL DEFAULT 'percent',value INTEGER NOT NULL,active INTEGER DEFAULT 1,expires TEXT DEFAULT '',uses INTEGER DEFAULT 0,max_uses INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS favorites(user_id INTEGER REFERENCES users(id),book_id INTEGER REFERENCES books(id),PRIMARY KEY(user_id,book_id));
        CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),book_id INTEGER REFERENCES books(id),score INTEGER CHECK(score BETWEEN 1 AND 5),body TEXT,approved INTEGER DEFAULT 0,created TEXT);
        CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),title TEXT,body TEXT,status TEXT DEFAULT 'open',created TEXT);
        CREATE TABLE IF NOT EXISTS returns(id INTEGER PRIMARY KEY,order_item_id INTEGER REFERENCES order_items(id),user_id INTEGER REFERENCES users(id),reason TEXT,status TEXT DEFAULT 'requested',created TEXT);
        CREATE TABLE IF NOT EXISTS audit_events(id INTEGER PRIMARY KEY,actor_id INTEGER,action TEXT NOT NULL,reference TEXT,note TEXT,created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS catalog_identity_links(node_book_id INTEGER NOT NULL PRIMARY KEY,retail_book_id INTEGER NOT NULL UNIQUE REFERENCES books(id) ON DELETE RESTRICT,node_title_at_link TEXT NOT NULL,retail_title_at_link TEXT NOT NULL,node_author_at_link TEXT NOT NULL DEFAULT '',retail_author_at_link TEXT NOT NULL DEFAULT '',linked_at TEXT NOT NULL,link_method TEXT NOT NULL DEFAULT 'unique_title_author_v98');
        CREATE INDEX IF NOT EXISTS idx_catalog_identity_retail ON catalog_identity_links(retail_book_id);
        CREATE INDEX IF NOT EXISTS idx_books_shop ON books(shop_id);
        CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
        CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
        CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
        ''')
        if 'bridge_external_id' not in {x[1] for x in c.execute('PRAGMA table_info(sessions)')}:
            c.execute('ALTER TABLE sessions ADD COLUMN bridge_external_id TEXT')
        if 'bridge_node_id' not in {x[1] for x in c.execute('PRAGMA table_info(users)')}:
            c.execute('ALTER TABLE users ADD COLUMN bridge_node_id INTEGER')
        if 'bridge_store_id' not in {x[1] for x in c.execute('PRAGMA table_info(users)')}:
            c.execute('ALTER TABLE users ADD COLUMN bridge_store_id INTEGER')
        if 'bridge_store_id' not in {x[1] for x in c.execute('PRAGMA table_info(shops)')}:
            c.execute('ALTER TABLE shops ADD COLUMN bridge_store_id INTEGER')
        c.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_bridge_node ON users(bridge_node_id) WHERE bridge_node_id IS NOT NULL')
        c.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_bridge_store ON shops(bridge_store_id) WHERE bridge_store_id IS NOT NULL')

def hashpass(p):
    salt=secrets.token_bytes(16)
    raw=hashlib.pbkdf2_hmac('sha256',p.encode(),salt,280_000)
    return 'pbkdf2$'+base64.b64encode(salt).decode()+'$'+base64.b64encode(raw).decode()
def verify(p,s):
    try:
        _,a,b=s.split('$')
        candidate=hashlib.pbkdf2_hmac('sha256',p.encode(),base64.b64decode(a),280_000)
        return hmac.compare_digest(candidate,base64.b64decode(b))
    except Exception: return False

def setup_admin(u,p):
    if len(u)<3 or len(p)<12: raise ValueError('نام کاربری حداقل ۳ و رمز حداقل ۱۲ نویسه باشد.')
    with db() as c:
        existing=c.execute("SELECT id FROM users WHERE role='admin' LIMIT 1").fetchone()
        if existing: raise ValueError('مدیر قبلاً ساخته شده؛ این فرمان مدیر فعلی را بازنویسی نمی‌کند.')
        c.execute('INSERT INTO users(username,passhash,role,created) VALUES(?,?,?,?)',(u,hashpass(p),'admin',now()))
        admin_id=c.execute('SELECT id FROM users WHERE username=?',(u,)).fetchone()['id']
        c.execute('INSERT OR IGNORE INTO shops(name,slug,owner_id,description) VALUES(?,?,?,?)',('فروشگاه اصلی ورق','varaq',admin_id,'انتخاب کتاب‌های خواندنی و ارزشمند'))
        c.execute("UPDATE shops SET owner_id=? WHERE slug='varaq' AND owner_id IS NULL", (admin_id,))

def bridge_claim(headers, peer):
    """Authenticate a short-lived signed assertion, NEVER a client supplied user id."""
    if not BRIDGE_ENABLED or peer not in ('127.0.0.1', '::1'):
        return None
    token=headers.get('X-Varaq-Bridge','')
    if not token or len(token)>1200 or token.count('.')!=1:
        return None
    try:
        raw, mac=token.split('.')
        if not re.fullmatch(r'[A-Za-z0-9_-]+',raw) or not re.fullmatch(r'[a-f0-9]{64}',mac):return None
        expected=hmac.new(bytes.fromhex(BRIDGE_SECRET),raw.encode('ascii'),hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected,mac):return None
        claim=json.loads(base64.urlsafe_b64decode(raw+'='*(-len(raw)%4)))
        if not isinstance(claim,dict) or abs(int(time.time())-int(claim.get('ts',0)))>30:return None
        if claim.get('role') not in ('owner','seller'):return None
        uid=claim.get('id')
        if not isinstance(uid,int) or uid<1 or uid>2**52:return None
        if not isinstance(claim.get('name'),str) or len(claim['name'])>50:return None
        if claim['role']=='seller':
            if claim.get('permission')!='manager':return None
            storeid=claim.get('store_id')
            if not isinstance(storeid,int) or storeid<1:return None
        return claim
    except (ValueError,TypeError,OverflowError,UnicodeError,KeyError):
        return None

def bridge_user(c,claim):
    """Map an approved Node account to a stable restricted Python identity."""
    nid=claim['id']; role='admin' if claim['role']=='owner' else 'seller'
    row=c.execute('SELECT * FROM users WHERE bridge_node_id=?',(nid,)).fetchone()
    if not row:
        username=f'node_{nid}_{re.sub(r"[^\w-]","_",claim["name"])[:25]}'
        # Never copy Node passwords or create a usable known retail password.
        c.execute('INSERT INTO users(username,passhash,role,created,bridge_node_id) VALUES(?,?,?,?,?)',
                  (username,hashpass(secrets.token_urlsafe(48)),role,now(),nid))
        row=c.execute('SELECT * FROM users WHERE bridge_node_id=?',(nid,)).fetchone()
    elif row['role']!=role:
        c.execute('UPDATE users SET role=? WHERE id=?',(role,row['id']))
    if role=='seller':
        sid=int(claim['store_id'])
        shop=c.execute('SELECT id FROM shops WHERE bridge_store_id=?',(sid,)).fetchone()
        if not shop:
            # v9.5's imported catalog is in the first shop; keep its 1000 books.
            legacy=c.execute("SELECT id FROM shops WHERE id=1 AND slug='varaq' AND bridge_store_id IS NULL").fetchone() if sid==1 else None
            if legacy:
                c.execute('UPDATE shops SET bridge_store_id=? WHERE id=?',(sid,legacy['id']))
                shop=legacy
            else:
                shopname=str(claim.get('store_name') or 'فروشگاه ورق')[:100]
                candidate='node-store-'+str(sid)
                c.execute('INSERT INTO shops(name,slug,description,bridge_store_id) VALUES(?,?,?,?)',
                          (shopname,candidate,'فروشگاه متصل به پنل اصلی ورق',sid))
                shop=c.execute('SELECT id FROM shops WHERE bridge_store_id=?',(sid,)).fetchone()
        c.execute('UPDATE users SET bridge_store_id=? WHERE id=?',(sid,row['id']))
    return row['id']

def mounted_html(doc):
    if not BASE_PATH:return doc
    # Escape only absolute local URL attributes, not external URLs or text.
    doc=re.sub(r'((?:href|src|action)=["\'])/(?!/)',lambda m:m.group(1)+BASE_PATH+'/',doc)
    # Non-market catalogue and original editorial pages remain on the Node server.
    doc=doc.replace('<header class="nav">','<header class="nav"><div class="wrap"><a class="small muted" href="/">بازگشت به مرجع کتاب ورق</a></div>',1)
    return doc

def getbook(c,bid): return c.execute("SELECT b.*,s.name shop_name,s.slug shop_slug FROM books b JOIN shops s ON b.shop_id=s.id WHERE b.id=?",(bid,)).fetchone()

def btn(label,path='#',cls='btn'):
    return f'<a class="{cls}" href="{H(path)}">{H(label)}</a>'
def csrf(inp): return f'<input type="hidden" name="csrf" value="{H(inp)}">'
def postform(action,inner,token,klass=''):
    return f'<form action="{H(action)}" method="post" class="{klass}">{csrf(token)}{inner}</form>'
def field(name,label,value='',typ='text',required=False,extra=''):
    return f'<label class="field">{H(label)}<input name="{H(name)}" type="{H(typ)}" value="{H(value)}" {"required" if required else ""} {extra}></label>'
def choose(name,label,opts,current=''):
    return f'<label class="field">{H(label)}<select name="{H(name)}">'+''.join(f'<option value="{H(k)}" {"selected" if str(k)==str(current) else ""}>{H(v)}</option>' for k,v in opts)+'</select></label>'
def area(name,label,value=''):
    return f'<label class="field">{H(label)}<textarea name="{H(name)}" rows="4">{H(value)}</textarea></label>'
def cover(book):
    val=book['cover'] or ''
    if val and re.fullmatch(r'[a-zA-Z0-9_\-.]+',val) and ((COVERS/val).is_file() or (re.fullmatch(r'v86_book-\d{3,4}\.webp',val) and (LEGACY_COVERS/val[4:]).is_file())):
        return f'/covers/{quote(val)}'
    return '/cover-fallback.svg'
def bookcard(b,token):
    available=b['kind']=='pdf' or b['stock']>0
    action=postform('/cart/add',f'<input type="hidden" name="book_id" value="{b["id"]}"><button class="btn smallbtn" type="submit">افزودن به سبد</button>',token) if available else '<span class="pill">ناموجود</span>'
    return f'''<article class="book-card"><a href="/book/{b['id']}" class="cover"><img src="{H(cover(b))}" alt="جلد کتاب {H(b['title'])}" loading="lazy"></a><div class="book-body"><div class="sub">{H(b['category'])} · {H(b['shop_name'])}</div><a class="book-title" href="/book/{b['id']}">{H(b['title'])}</a><p class="muted small">{H(b['author'] or 'نویسنده ثبت نشده')}</p><b>{money(b['price'])}</b><div class="small muted">{'PDF' if b['kind']=='pdf' else ('چاپی + PDF' if b['kind']=='both' else 'نسخه چاپی')}</div>{action}</div></article>'''

CSS = '''
:root{--paper:#f8f7f3;--card:#fff;--text:#1c2c29;--sub:#64736e;--accent:#1d5d4f;--gold:#c69a57;--line:#e4e9e3;--shadow:0 12px 38px #173e2a0b}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--text);font-family:Vazirmatn,Estedad,Tahoma,'Segoe UI',sans-serif;line-height:1.8;direction:rtl}a{text-decoration:none;color:inherit}img{display:block;max-width:100%}button,input,select,textarea{font:inherit}button{cursor:pointer}.wrap{max-width:1210px;margin:auto;padding:0 24px}.top{background:#173d35;color:#eef5ee;padding:8px 0;font-size:12px;text-align:center}.nav{background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:15}.navin{display:flex;align-items:center;gap:22px;min-height:77px;flex-wrap:wrap}.brand{font-size:26px;font-weight:900;letter-spacing:-1px;color:var(--accent)}.brand small{display:block;font-size:11px;color:var(--sub);letter-spacing:0;font-weight:400;line-height:1.2}.navlinks{display:flex;align-items:center;flex-wrap:wrap;gap:16px;font-size:14px}.navlinks a:hover,.links a:hover{color:var(--gold)}.nav .search{flex:1;min-width:190px;display:flex;gap:8px}.search input{width:100%;background:#f5f6f2;border:1px solid var(--line);border-radius:12px;padding:9px 15px}.search button,.btn{background:var(--accent);color:white;border:1px solid var(--accent);padding:10px 20px;border-radius:12px;font-weight:600;display:inline-block;text-align:center}.btn:hover,.search button:hover{background:#134c3d;color:#fff}.btn.outline{background:#fff;color:var(--accent)}.btn.light{background:#f0f5f1;color:var(--accent);border-color:var(--line)}.smallbtn{font-size:12px;padding:7px 12px;margin-top:12px}main{min-height:72vh;padding:28px 0 70px}h1,h2,h3{line-height:1.4}h1{font-size:32px;margin:8px 0 14px}h2{font-size:24px;margin:0 0 20px}.muted,.sub{color:var(--sub)}.small,.sub{font-size:12px}.eyebrow{color:var(--gold);font-size:13px;font-weight:800;letter-spacing:.2px}.hero{background:linear-gradient(115deg,#153b34,#2d695b);border-radius:26px;color:white;display:grid;grid-template-columns:1.45fr .55fr;padding:50px;gap:32px;min-height:300px;overflow:hidden;margin-bottom:38px}.hero h1{font-size:38px}.hero p{color:#d8e7df;max-width:600px}.hero .btn{background:#ebd4a8;border-color:#ebd4a8;color:#193e36}.hero-graphic{font-size:150px;align-self:center;text-align:center;transform:rotate(-12deg);text-shadow:20px 16px #ffffff20}.section-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:22px 0}.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:17px}.book-card,.panel{background:var(--card);border-radius:18px;border:1px solid var(--line);box-shadow:var(--shadow);overflow:hidden}.book-card{display:flex;flex-direction:column;min-width:0}.book-card .cover{height:240px;padding:14px;background:linear-gradient(140deg,#eee9da,#e0e8e0);display:flex;justify-content:center}.book-card .cover img{width:100%;height:100%;object-fit:contain;border-radius:5px;box-shadow:2px 8px 12px #2222}.book-body{padding:17px}.book-title{display:block;font-size:15px;font-weight:850;min-height:52px}.panel{padding:24px;margin-bottom:18px}.catlist{display:flex;gap:9px;flex-wrap:wrap;margin-bottom:22px}.catlist a{padding:8px 14px;border:1px solid var(--line);border-radius:100px;background:#fff;color:var(--accent);font-size:13px}.catlist a.on{background:var(--accent);color:#fff}.layout{display:grid;grid-template-columns:260px 1fr;gap:22px}.field{display:flex;flex-direction:column;gap:6px;margin:11px 0;font-size:13px;font-weight:700}.field input,.field textarea,.field select{width:100%;padding:11px 14px;border:1px solid #d7dfd8;border-radius:11px;background:#fff;outline-color:var(--accent);font-weight:400}.formgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.flash{padding:14px 16px;border-radius:12px;background:#e7f3ec;color:#195b40;margin-bottom:19px;border:1px solid #c7e6cf}.flash.bad{background:#fff0ea;border-color:#f4c7b8;color:#922e1d}.tablewrap{overflow:auto}.table{border-collapse:collapse;width:100%;min-width:630px}.table th,.table td{text-align:right;padding:12px;border-bottom:1px solid var(--line);vertical-align:middle;font-size:13px}.table th{color:var(--sub);font-size:12px}.mini{width:48px;height:65px;object-fit:contain;border-radius:3px}.footer{background:#142f2b;color:#d4e0d8;padding:38px 0;font-size:13px}.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.book-detail{display:grid;grid-template-columns:minmax(200px,340px) 1fr;gap:40px}.detail-cover{background:#f0eee5;border-radius:18px;padding:25px;display:flex;justify-content:center}.detail-cover img{max-height:520px;box-shadow:14px 18px 25px #2222}.price{font-size:24px;font-weight:900;color:var(--accent)}.side-nav a{display:block;padding:10px 12px;border-radius:8px;color:var(--accent)}.side-nav a:hover{background:#ecf4ef}.empty{text-align:center;padding:60px 18px;background:#fff;border:1px dashed var(--line);border-radius:20px}.pill{background:#f1eee5;color:#78613d;padding:4px 10px;border-radius:100px;display:inline-block;font-size:12px}.thumb{width:70px;height:90px;object-fit:contain;border-radius:5px}.totals{max-width:440px;margin:22px auto 0 0}.rowline{display:flex;justify-content:space-between;gap:20px;padding:9px 0;border-bottom:1px solid var(--line)}.error{color:#ad352b;font-size:13px}.navfilter{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.badge-status{font-size:12px;padding:4px 11px;background:#eef2ee;border-radius:100px}input[type=number]{max-width:155px}.rating{color:#c39938}.copy{font-size:13px;color:var(--sub)}@media(max-width:1100px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}.navin{gap:10px}.nav .search{order:3;width:100%;flex-basis:100%;padding-bottom:12px}}@media(max-width:800px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.layout,.book-detail{grid-template-columns:1fr}.hero{grid-template-columns:1fr;padding:34px 28px;min-height:240px}.hero-graphic{display:none}.hero h1{font-size:30px}.wrap{padding:0 14px}.navin{min-height:64px}.navlinks{gap:10px;font-size:12px}.cols,.formgrid{grid-template-columns:1fr}.book-card .cover{height:210px}}@media(max-width:390px){.grid{gap:9px}.book-card .cover{height:170px;padding:8px}.book-body{padding:11px}.book-title{font-size:13px}.brand{font-size:23px}h1{font-size:26px}}
'''

class Site(BaseHTTPRequestHandler):
    server_version='VARAQ/9.8'
    def log_message(self,fmt,*args): print('[%s] '%self.log_date_time_string()+fmt%args)
    def conn(self): return db()
    def state(self):
        cookie=self.headers.get('Cookie','')
        m=re.search(r'(?:^|;\s*)varaq_session=([a-f0-9]{48})',cookie)
        sid=m.group(1) if m else ''
        claim=bridge_claim(self.headers, self.client_address[0])
        with self.conn() as c:
            c.execute('DELETE FROM sessions WHERE expires<?',(int(time.time()),))
            s=c.execute('SELECT * FROM sessions WHERE id=?',(sid,)).fetchone()
            if not s:
                sid=secrets.token_hex(24)
                tok=secrets.token_urlsafe(32)
                c.execute('INSERT INTO sessions(id,csrf,cart_json,expires) VALUES(?,?,?,?)',(sid,tok,'{}',int(time.time())+60*60*24*14))
                s=c.execute('SELECT * FROM sessions WHERE id=?',(sid,)).fetchone()
            self.sid=sid
            self.csrf=s['csrf']
            self.cart=json.loads(s['cart_json'] or '{}')
            self.user=c.execute('SELECT * FROM users WHERE id=?',(s['user_id'],)).fetchone() if s['user_id'] else None
            self.user_id=s['user_id']
            if BRIDGE_ENABLED:
                # A logout or account switch in Node must revoke retail privileges instantly.
                if claim:
                    uid=bridge_user(c,claim)
                    if uid!=self.user_id or s['bridge_external_id']!=str(claim['id']):
                        new_sid=secrets.token_hex(24)
                        c.execute('UPDATE sessions SET id=?,user_id=?,csrf=?,bridge_external_id=? WHERE id=?',
                                  (new_sid,uid,secrets.token_urlsafe(32),str(claim['id']),self.sid))
                        self.sid=new_sid
                        self.csrf=c.execute('SELECT csrf FROM sessions WHERE id=?',(self.sid,)).fetchone()['csrf']
                        self.user_id=uid
                    self.user=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
                elif s['bridge_external_id']:
                    c.execute('UPDATE sessions SET user_id=NULL,bridge_external_id=NULL,csrf=? WHERE id=?',
                              (secrets.token_urlsafe(32),self.sid))
                    self.user=None
                    self.user_id=None
                    self.csrf=c.execute('SELECT csrf FROM sessions WHERE id=?',(self.sid,)).fetchone()['csrf']
    def render(self,content,title='فروشگاه کتاب ورق',status=200,msg='',bad=False):
        with self.conn() as c:
            n=c.execute('SELECT COUNT(*) n FROM shops WHERE active=1').fetchone()['n']
        role=self.user['role'] if self.user else ''
        right = '<a href="/account">حساب من</a>' if self.user else '<a href="/login">ورود / ثبت‌نام</a>'
        toolbar = '<a href="/seller">پنل فروشنده</a>' if role in ('seller','admin') else ''
        admin = '<a href="/admin">مدیریت کل</a>' if role=='admin' else ''
        count=sum(int(v) for v in self.cart.values())
        msg_html=f'<div class="flash {"bad" if bad else ""}">{H(msg)}</div>' if msg else ''
        doc=f'''<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{H(title)} | ورق</title><meta name="description" content="کتاب‌ها، نویسندگان و فروشگاه‌های کتاب ورق. خرید نسخه چاپی و نسخه دیجیتال با مدیریت مستقل فروشندگان."><meta name="theme-color" content="#1d5d4f"><link rel="icon" href="/favicon.svg"><style>{CSS}</style></head><body><div class="top">ورق، مسیر ساده‌تر برای کشف و خرید کتاب · {n} فروشگاه فعال</div><header class="nav"><div class="wrap navin"><a class="brand" href="/">ورق<small>کتاب، دانش، انتخاب</small></a><nav class="navlinks"><a href="/books">کتاب‌ها</a><a href="/shops">فروشگاه‌ها</a><a href="/support">پشتیبانی</a>{right}{toolbar}{admin}<a href="/cart">سبد خرید ({count})</a></nav><form class="search" action="/books" method="get"><input name="q" placeholder="نام کتاب، نویسنده یا موضوع را جست‌وجو کنید…" aria-label="جست‌وجو کتاب"><button>جست‌وجو</button></form></div></header><main><div class="wrap">{msg_html}{content}</div></main><footer class="footer"><div class="wrap cols"><div><strong>ورق</strong><p>سامانه معرفی، بررسی و فروش کتاب؛ ساخته‌شده برای رشد فروشگاه‌های مستقل.</p></div><div><strong>راهنما</strong><p><a href="/support">پشتیبانی</a> · <a href="/policies">قوانین خرید</a> · <a href="/books">فهرست کتاب‌ها</a></p></div><div><strong>یادداشت پرداخت</strong><p>پرداخت اینترنتی تا اتصال درگاه معتبرِ خود فروشنده فعال نخواهد شد.</p></div></div></footer></body></html>'''
        self.send_response(status)
        self.send_header('Content-Type','text/html; charset=utf-8')
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Referrer-Policy','strict-origin-when-cross-origin')
        self.send_header('Content-Security-Policy',"default-src 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        self.send_header('Set-Cookie',f'varaq_session={self.sid}; HttpOnly; SameSite=Lax; Path={BASE_PATH or '/'}; Max-Age=1209600'+('; Secure' if PUBLIC_URL.startswith('https://') else ''))
        encoded=mounted_html(doc).encode('utf-8')
        self.send_header('Content-Length',str(len(encoded)))
        self.end_headers();self.wfile.write(encoded)
    def redirect(self,url):
        self.send_response(303)
        self.send_header('Location',BASE_PATH+url if BASE_PATH and url.startswith('/') and not url.startswith('//') else url)
        self.send_header('Set-Cookie',f'varaq_session={self.sid}; HttpOnly; SameSite=Lax; Path={BASE_PATH or '/'}; Max-Age=1209600'+('; Secure' if PUBLIC_URL.startswith('https://') else ''))
        self.end_headers()
    def binary(self,content,typ='application/octet-stream',filename=None):
        self.send_response(200)
        self.send_header('Content-Type',typ)
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Cache-Control','private, no-store' if filename else 'public, max-age=86400')
        if filename:self.send_header('Content-Disposition',f'attachment; filename="{filename}"')
        self.send_header('Content-Length',str(len(content)))
        self.end_headers();self.wfile.write(content)
    def err(self,message,status=400): self.render('<div class="panel"><h2>درخواست انجام نشد</h2><p>'+H(message)+'</p>'+btn('بازگشت','/','btn light')+'</div>',status=status)
    def require(self,roles=None):
        if not self.user:
            self.err('برای ادامه وارد حساب خود شوید.',401);return False
        if roles and self.user['role'] not in roles:
            self.err('شما به این بخش دسترسی ندارید.',403);return False
        return True
    def save_cart(self):
        with self.conn() as c: c.execute('UPDATE sessions SET cart_json=? WHERE id=?',(json.dumps(self.cart),self.sid))
    def body(self):
        n=int(self.headers.get('Content-Length','0'))
        if n>MAX_UPLOAD:raise ValueError('حجم درخواست بیش از حد مجاز است (۳۲ مگابایت).')
        raw=self.rfile.read(n)
        typ=self.headers.get('Content-Type','')
        if 'multipart/form-data' in typ:
            msg=BytesParser(policy=default).parsebytes((f'MIME-Version: 1.0\r\nContent-Type: {typ}\r\n\r\n').encode()+raw)
            data={}; files={}
            for part in msg.iter_parts():
                disp=part.get('Content-Disposition','')
                n=re.search(r'name="([^"]+)"',disp)
                if not n: continue
                key=n.group(1);content=part.get_payload(decode=True) or b''
                f=re.search(r'filename="([^"]*)"',disp)
                if f and f.group(1):files[key]=(os.path.basename(f.group(1)),content)
                else:data[key]=content.decode('utf-8','replace')
            return data,files
        return {k:v[0] for k,v in parse_qs(raw.decode('utf-8','replace'),keep_blank_values=True).items()},{}
    def do_GET(self):
        self.state()
        p=urlparse(self.path);path=unquote(p.path);query={k:v[0] for k,v in parse_qs(p.query).items()}
        try:
            if path=='/favicon.svg':return self.binary(b'<svg xmlns="http://www.w3.org/2000/svg" width="70" height="70"><rect width="70" height="70" rx="15" fill="#1d5d4f"/><text x="35" y="49" font-size="43" text-anchor="middle" fill="white">W</text></svg>','image/svg+xml')
            if path=='/cover-fallback.svg':return self.binary(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 430"><rect width="300" height="430" fill="#1e5046"/><path d="M50 45h200v340H50z" fill="none" stroke="#dcbe83" stroke-width="4"/><path d="M90 160h120m-120 25h120m-120 25h120" stroke="#dcbe83" stroke-width="7"/><text x="150" y="310" fill="#eedfc6" font-family="sans-serif" text-anchor="middle" font-size="40">VARAQ</text></svg>','image/svg+xml')
            if path.startswith('/covers/'):
                name=path[len('/covers/'):]
                if not re.fullmatch(r'[a-zA-Z0-9_\-.]+',name):return self.err('نام فایل نامعتبر است.',404)
                if re.fullmatch(r'v86_book-\d{3,4}\.webp',name):
                    f=LEGACY_COVERS/name[4:]
                else:
                    f=COVERS/name
                if not f.is_file():return self.err('جلد پیدا نشد.',404)
                typ=mimetypes.guess_type(name)[0]
                if typ not in ('image/png','image/jpeg','image/webp','image/svg+xml','image/gif'):return self.err('فایل تصویر معتبر نیست.',404)
                return self.binary(f.read_bytes(),typ)
            if path=='/health':return self.binary(b'{"ok":true,"name":"VARAQ"}','application/json')
            if path=='/robots.txt':return self.binary(b'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /seller\nDisallow: /checkout\nDisallow: /account\nSitemap: /sitemap.xml\n','text/plain')
            if path=='/sitemap.xml':return self.sitemap()
            if path=='/api/books':return self.api_books(query)
            if path=='/':return self.home()
            if path=='/books':return self.catalog(query)
            if path.startswith('/book/'):return self.detail(path.split('/')[-1])
            if path.startswith('/legacy-book/'):return self.legacy_book_link(path.rsplit('/',1)[-1])
            if path=='/shops':return self.shops()
            if path.startswith('/shop/'):return self.shop(path.rsplit('/',1)[-1])
            if path=='/cart':return self.cart_view()
            if path=='/checkout':return self.checkout()
            if path=='/login':return self.login_page()
            if path=='/register':return self.register_page()
            if path=='/account':return self.account()
            if path=='/account/security':return self.account_security()
            if path.startswith('/invoice/'):return self.invoice(path.rsplit('/',1)[-1])
            if path=='/favorites':return self.favorites()
            if path=='/support':return self.support()
            if path=='/policies':return self.policies()
            if path.startswith('/download/'):return self.download(path.split('/')[-1])
            if path=='/seller':return self.seller(query)
            if path.startswith('/seller/order/'):return self.seller_order_view(path.rsplit('/',1)[-1],query)
            if path=='/admin':return self.admin(query)
            if path=='/admin/export':return self.export_orders()
            if path=='/admin/catalog/export':return self.export_catalog()
            if path=='/admin/catalog/audit.json':return self.catalog_audit_json()
            if path=='/admin/migration':return self.migration_status()
            if path=='/admin/integration':return self.integration_status()
            if path=='/admin/catalog-links':return self.catalog_link_status()
            return self.err('صفحه پیدا نشد.',404)
        except Exception as e:
            print('GET error:',repr(e));return self.err('خطای داخلی؛ جزئیات در کنسول سرور ثبت شد.',500)
    def stop_request(self):
        from ipaddress import ip_address
        try: local=ip_address(self.client_address[0]).is_loopback
        except ValueError: local=False
        target=DATA/'stop.token'
        if not local or not target.exists() or not hmac.compare_digest(self.headers.get('X-Stop-Token',''),target.read_text()):
            return self.err('این فرمان فقط برای برنامه محلی مجاز است.',403)
        self.binary(b'{"stopping":true}','application/json')
        threading.Thread(target=self.server.shutdown,daemon=True).start()
    def do_POST(self):
        self.state()
        try:
            if urlparse(self.path).path=='/internal/stop':return self.stop_request()
            data,files=self.body()
            if not hmac.compare_digest(data.get('csrf',''),self.csrf):return self.err('نشست شما منقضی شده یا اعتبار فرم تأیید نشد.',403)
            path=urlparse(self.path).path
            actions={'/register':self.register,'/login':self.login,'/logout':self.logout,'/account/password':self.change_password,'/cart/add':self.cart_add,'/cart/update':self.cart_update,'/checkout':self.place_order,'/favorites/toggle':self.fav_toggle,'/reviews/add':self.review_add,'/support/new':self.ticket_add,'/returns/new':self.return_request,'/seller/book':lambda d:self.book_save(d,files),'/seller/coupon':self.coupon_save,'/seller/order':self.seller_order_update,'/admin/shop':self.admin_shop,'/admin/user':self.admin_user,'/admin/payment':self.admin_payment,'/admin/review':self.admin_review,'/admin/return':self.admin_return,'/admin/import':lambda d:self.import_upload(d,files)}
            fn=actions.get(path)
            if not fn:return self.err('درخواست شناخته نشد.',404)
            return fn(data)
        except ValueError as e:return self.err(str(e),400)
        except Exception as e:
            print('POST error:',repr(e));return self.err('عملیات انجام نشد؛ گزارش خطا در کنسول سرور موجود است.',500)
    def home(self):
        with self.conn() as c:
            books=c.execute("SELECT b.*,s.name shop_name FROM books b JOIN shops s ON b.shop_id=s.id WHERE b.status='active' AND s.active=1 ORDER BY b.id DESC LIMIT 10").fetchall()
            cats=c.execute("SELECT category,COUNT(*) n FROM books WHERE status='active' GROUP BY category ORDER BY n DESC LIMIT 10").fetchall()
        intro='<section class="hero"><div><div class="eyebrow">کتابخانه‌ای برای هر سلیقه</div><h1>هر داستان، یک جهان تازه</h1><p>دسته‌بندی دقیق، جست‌وجوی ساده و تجربه خرید یکپارچه برای کتاب چاپی و نسخه دیجیتال از فروشگاه‌های معتبر.</p>'+btn('دیدن کتاب‌ها','/books')+'</div><div class="hero-graphic">📚</div></section>'
        cats_html='<div class="catlist">'+''.join(f'<a href="/books?category={quote(x["category"])}">{H(x["category"])} ({x["n"]})</a>' for x in cats)+'</div>'
        cards='<div class="grid">'+''.join(bookcard(b,self.csrf) for b in books)+'</div>' if books else '<div class="empty"><h3>فهرست آماده دریافت کتاب‌هاست</h3><p>برای حفظ اصالت اطلاعات، عنوان و نویسنده ساختگی وارد نشده است. مدیر یا فروشنده می‌تواند کتاب‌ها را بارگذاری کند.</p>'+btn('ورود مدیریت','/login')+'</div>'
        self.render(intro+'<div class="section-head"><h2>موضوع‌های پرطرفدار</h2></div>'+cats_html+'<div class="section-head"><h2>تازه‌ترین کتاب‌ها</h2>'+btn('همه کتاب‌ها','/books','btn outline')+'</div>'+cards)
    def catalog(self,q):
        where=["b.status='active'","s.active=1"];params=[]
        if q.get('q'):where.append('(b.title LIKE ? OR b.author LIKE ? OR b.description LIKE ? OR b.isbn LIKE ?)');params += ['%'+q['q']+'%']*4
        if q.get('category'):where.append('b.category=?');params.append(q['category'])
        if q.get('kind') in ('pdf','physical'):where.append("(b.kind=? OR b.kind='both')");params.append(q['kind'])
        if q.get('shop','').isdigit():where.append('b.shop_id=?');params.append(int(q['shop']))
        if q.get('available')=='1':where.append("(b.stock>0 OR b.kind='pdf')")
        for name,op in (('min_price','>='),('max_price','<=')):
            if q.get(name):
                if not q[name].isdigit():return self.err('محدوده قیمت باید عدد مثبت باشد.',400)
                where.append('b.price '+op+' ?');params.append(int(q[name]))
        sorts={'new':'b.id DESC','old':'b.id ASC','cheap':'b.price ASC,b.id DESC','expensive':'b.price DESC,b.id DESC','title':'b.title COLLATE NOCASE ASC'}
        ordering=sorts.get(q.get('sort','new'),sorts['new'])
        try:page=max(1,int(q.get('page','1')))
        except:page=1
        with self.conn() as c:
            w=' AND '.join(where)
            total=c.execute('SELECT COUNT(*) n FROM books b JOIN shops s ON b.shop_id=s.id WHERE '+w,params).fetchone()['n']
            books=c.execute('SELECT b.*,s.name shop_name FROM books b JOIN shops s ON b.shop_id=s.id WHERE '+w+' ORDER BY '+ordering+' LIMIT 25 OFFSET ?',params+[(page-1)*25]).fetchall()
            cats=c.execute("SELECT DISTINCT category FROM books ORDER BY category").fetchall()
            shops=c.execute("SELECT id,name FROM shops WHERE active=1 ORDER BY name").fetchall()
        nav='<div class="catlist"><a href="/books" class="on">همه</a>'+''.join(f'<a href="/books?category={quote(r["category"])}">{H(r["category"])}</a>' for r in cats)+'</div>'
        kinds='<form method="get" class="navfilter">'+field('q','جست‌وجو',q.get('q',''))+choose('kind','فرمت',[('','همه'),('physical','چاپی'),('pdf','PDF')],q.get('kind',''))+choose('shop','فروشنده',[('','همه فروشگاه‌ها')]+[(x['id'],x['name']) for x in shops],q.get('shop',''))+choose('sort','مرتب‌سازی',[('new','جدیدترین'),('old','قدیمی‌ترین'),('cheap','ارزان‌ترین'),('expensive','گران‌ترین'),('title','نام کتاب')],q.get('sort','new'))+field('min_price','حداقل قیمت',q.get('min_price',''),'number',False,'min="0"')+field('max_price','حداکثر قیمت',q.get('max_price',''),'number',False,'min="0"')+'<label class="field"><span>فقط موجود</span><input type="checkbox" name="available" value="1" '+('checked' if q.get('available')=='1' else '')+'></label><button class="btn" type="submit">اعمال فیلتر</button></form>'
        cards='<div class="grid">'+''.join(bookcard(b,self.csrf) for b in books)+'</div>' if books else '<div class="empty">کتابی مطابق جست‌وجوی شما پیدا نشد.</div>'
        url='/books?'+ '&'.join(k+'='+quote(v) for k,v in q.items() if k!='page')
        pagination='<div class="actions" style="margin-top:22px">'+(btn('صفحه قبل',url+'&page='+str(page-1),'btn light') if page>1 else '')+(btn('صفحه بعد',url+'&page='+str(page+1),'btn light') if page*25<total else '')+'</div>'
        self.render(f'<h1>کتاب‌ها</h1><p class="muted">{total} عنوان پیدا شد</p>{nav}<div class="panel">{kinds}</div>{cards}{pagination}','فهرست کتاب‌ها')
    def detail(self,k):
        if not k.isdigit():return self.err('کتاب وجود ندارد.',404)
        with self.conn() as c:
            b=getbook(c,int(k))
            if not b or b['status']!='active' or not c.execute('SELECT 1 FROM shops WHERE id=? AND active=1',(b['shop_id'],)).fetchone():return self.err('کتاب پیدا نشد.',404)
            reviews=c.execute('SELECT r.*,u.username FROM reviews r JOIN users u ON r.user_id=u.id WHERE r.book_id=? AND r.approved=1 ORDER BY r.id DESC LIMIT 12',(b['id'],)).fetchall()
        available=b['kind']=='pdf' or b['stock']>0
        form=postform('/cart/add',f'<input type="hidden" name="book_id" value="{b["id"]}">'+field('qty','تعداد','1','number',True,'min="1" max="50"')+'<button class="btn">افزودن به سبد خرید</button>',self.csrf) if available else '<span class="pill">این نسخه فعلاً ناموجود است.</span>'
        heart=postform('/favorites/toggle',f'<input type="hidden" name="book_id" value="{b["id"]}"><button class="btn light">♡ علاقه‌مندی‌ها</button>',self.csrf)
        info=f'''<div class="book-detail"><div class="detail-cover"><img src="{H(cover(b))}" alt="جلد {H(b['title'])}"></div><div><span class="pill">{H(b['category'])}</span><h1>{H(b['title'])}</h1><p>نویسنده: <strong>{H(b['author'])}</strong></p><p>انتشارات: {H(b['publisher'])} · سال: {H(b['year'])} · شابک: {H(b['isbn'])}</p><p>فروشنده: <a href="/shop/{H(b['shop_slug'])}">{H(b['shop_name'])}</a></p><p class="price">{money(b['price'])}</p><p>{'نسخه PDF' if b['kind']=='pdf' else 'چاپی و PDF' if b['kind']=='both' else 'چاپی'} · {'موجود' if b['stock']>0 or b['kind']=='pdf' else 'ناموجود'}</p><div class="actions">{form}{heart}</div></div></div><div class="panel" style="margin-top:28px"><h2>معرفی و خلاصه</h2><p>{H(b['description'])}</p></div>'''
        review_html='<div class="panel"><h2>نظر خوانندگان</h2>'+''.join(f'<div class="rowline"><b>{H(r["username"])} · <span class="rating">{r["score"]}/۵ ★</span></b><span>{H(r["body"])}</span></div>' for r in reviews)
        if self.user:review_html+=postform('/reviews/add',f'<input type="hidden" name="book_id" value="{b["id"]}">'+choose('score','امتیاز',[(i,str(i)+' ستاره') for i in range(1,6)],5)+area('body','نظر شما')+'<button class="btn">ثبت برای بررسی</button>',self.csrf)
        review_html+='</div>'
        self.render(info+review_html,b['title'])
    def shops(self):
        with self.conn() as c:r=c.execute('SELECT s.*,COUNT(b.id) n FROM shops s LEFT JOIN books b ON b.shop_id=s.id AND b.status="active" WHERE s.active=1 GROUP BY s.id ORDER BY s.id').fetchall()
        content='<h1>فروشگاه‌های همکار</h1><div class="cols">'+''.join(f'<div class="panel"><h3>{H(s["name"])}</h3><p class="muted">{H(s["description"])}</p><p>{s["n"]} عنوان کتاب</p>{btn("مشاهده", "/shop/"+s["slug"])}</div>' for s in r)+'</div>'
        self.render(content,'فروشگاه‌ها')
    def shop(self,s):
        with self.conn() as c:
            shop=c.execute('SELECT * FROM shops WHERE slug=? AND active=1',(s,)).fetchone()
            if not shop:return self.err('فروشگاه پیدا نشد.',404)
            books=c.execute('SELECT b.*,s.name shop_name FROM books b JOIN shops s ON b.shop_id=s.id WHERE b.shop_id=? AND b.status="active" ORDER BY b.id DESC LIMIT 60',(shop['id'],)).fetchall()
        self.render(f'<h1>{H(shop["name"])}</h1><p>{H(shop["description"])}</p><div class="grid">'+''.join(bookcard(b,self.csrf) for b in books)+'</div>',shop['name'])
    def cart_rows(self):
        rows=[]
        with self.conn() as c:
            for bid,qty in self.cart.items():
                if not str(bid).isdigit():continue
                b=getbook(c,int(bid))
                if b and b['status']=='active':rows.append((b,max(1,min(50,int(qty)))))
        return rows
    def cart_view(self):
        rows=self.cart_rows()
        if not rows:return self.render('<div class="empty"><h1>سبد خرید شما خالی است</h1>'+btn('بازگشت به کتاب‌ها','/books')+'</div>','سبد خرید')
        out='<h1>سبد خرید</h1><div class="panel tablewrap"><table class="table"><tr><th>کتاب</th><th>قیمت واحد</th><th>تعداد</th><th>جمع</th></tr>'
        for b,qty in rows:
            out+=f'<tr><td><div class="actions"><img class="thumb" src="{H(cover(b))}"><a href="/book/{b["id"]}">{H(b["title"])}</a></div></td><td>{money(b["price"])}</td><td>{postform("/cart/update",f"<input type=hidden name=book_id value={b['id']}><input type=number min=0 max=50 name=qty value={qty}><button class='btn light smallbtn'>ثبت</button>",self.csrf)}</td><td>{money(qty*b["price"])}</td></tr>'
        subtotal=sum(b['price']*q for b,q in rows)
        out+=f'</table></div><div class="panel totals"><div class="rowline"><b>جمع کالاها</b><b>{money(subtotal)}</b></div><p class="muted small">هزینه ارسال بر اساس فروشگاه و نوع کالا در تسویه‌حساب محاسبه می‌شود.</p>{btn("ادامه و تسویه‌حساب","/checkout")}</div>'
        self.render(out,'سبد خرید')
    def checkout(self):
        if not self.require():return
        rows=self.cart_rows()
        if not rows:return self.redirect('/cart')
        subtotal=sum(b['price']*qty for b,qty in rows)
        f=field('recipient','نام تحویل‌گیرنده',self.user['username'],'text',True)+field('phone','شماره تماس','','tel',True)+area('address','آدرس کامل تحویل (برای کتاب چاپی)')+field('coupon','کد تخفیف فروشگاه (اختیاری)')+choose('method','روش پرداخت',[('cod','پرداخت هنگام تحویل (فقط چاپی)'),('manual','ثبت سفارش و هماهنگی پرداخت با فروشگاه')])
        self.render('<h1>تسویه‌حساب</h1><div class="layout"><div class="panel">'+postform('/checkout',f+'<p class="small muted">پرداخت آنلاین تا تأیید درگاه مستقل هر فروشنده غیرفعال است. دانلود PDF تنها پس از تأیید واقعی پرداخت امکان‌پذیر می‌شود.</p><button class="btn">ثبت سفارش</button>',self.csrf)+'</div><div class="panel"><h3>خلاصه سفارش</h3><p>'+str(sum(q for b,q in rows))+' کالا</p><p class="price">'+money(subtotal)+'</p></div></div>','تسویه‌حساب')
    def login_page(self):
        if self.user:return self.redirect('/account')
        form=field('username','نام کاربری','','text',True)+field('password','رمز عبور','','password',True)+'<button class="btn">ورود</button>'
        self.render('<div class="panel" style="max-width:460px;margin:auto"><h1>ورود به ورق</h1>'+postform('/login',form,self.csrf)+'<p>حساب ندارید؟ <a href="/register">ثبت‌نام کنید</a></p></div>','ورود')
    def register_page(self):
        if self.user:return self.redirect('/account')
        f=field('username','نام کاربری','','text',True)+field('email','ایمیل (اختیاری)','','email')+field('password','رمز عبور، حداقل ۱۲ نویسه','','password',True)+'<button class="btn">ایجاد حساب</button>'
        self.render('<div class="panel" style="max-width:480px;margin:auto"><h1>عضویت در ورق</h1>'+postform('/register',f,self.csrf)+'</div>','ثبت‌نام')
    def account(self):
        if not self.require():return
        with self.conn() as c:
            rows=c.execute('''SELECT o.*,GROUP_CONCAT(so.status, ',') fulfillment_statuses
                              FROM orders o LEFT JOIN shop_orders so ON so.order_id=o.id
                              WHERE o.user_id=? GROUP BY o.id ORDER BY o.id DESC LIMIT 40''',(self.user_id,)).fetchall()
            purchases=c.execute('''SELECT oi.id,oi.title_snapshot,oi.kind,o.payment_status,so.status fulfillment_status
                        FROM order_items oi JOIN orders o ON oi.order_id=o.id
                        LEFT JOIN shop_orders so ON so.order_id=oi.order_id AND so.shop_id=oi.shop_id
                        WHERE o.user_id=? AND oi.kind IN ('pdf','both') ORDER BY oi.id DESC LIMIT 40''',(self.user_id,)).fetchall()
            orderitems=c.execute('SELECT oi.id,oi.order_id,oi.title_snapshot,oi.qty FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.user_id=? ORDER BY oi.id DESC LIMIT 200',(self.user_id,)).fetchall()
        security=(btn('امنیت حساب در پنل اصلی','../panel/account','btn light')+'<span class="muted small">برای خروج، از پنل اصلی خارج شوید.</span>') if self.user['bridge_node_id'] is not None else (btn('امنیت حساب','/account/security','btn light')+postform('/logout','<button class="btn outline">خروج</button>',self.csrf))
        out='<h1>حساب کاربری</h1><div class="panel"><b>سلام، '+H(self.user['username'])+'</b><div class="actions">'+btn('علاقه‌مندی‌ها','/favorites','btn light')+security+'</div></div><div class="panel"><h2>سفارش‌های من</h2><div class="tablewrap"><table class="table"><tr><th>کد سفارش</th><th>زمان</th><th>مبلغ</th><th>پرداخت</th><th>وضعیت</th></tr>'
        labels={'new':'جدید','preparing':'در حال آماده‌سازی','shipped':'ارسال‌شده','delivered':'تحویل‌شده','cancelled':'لغوشده'}
        for x in rows:
            states=[labels.get(st,st) for st in (x['fulfillment_statuses'] or '').split(',') if st]
            state_text='، '.join(sorted(set(states))) or 'در انتظار بررسی'
            payment='تأییدشده' if x['payment_status']=='paid' else ('پرداخت هنگام تحویل' if x['payment_method']=='cod' else 'در انتظار تأیید')
            out+=f'<tr><td><a href="/invoice/{x["id"]}">{H(x["code"])}</a></td><td>{H(x["created"])}</td><td>{money(x["total"])}</td><td>{H(payment)}</td><td>{H(state_text)}</td></tr>'
        out+='</table></div><p class="small muted">اقلام سفارش:</p>'+''.join(f'<p class="small">ردیف #{x["id"]} · {H(x["title_snapshot"])} · تعداد {x["qty"]}</p>' for x in orderitems)+'</div><div class="panel"><h2>کتابخانه دیجیتال</h2>'
        for x in purchases:
            out+=f'<div class="rowline"><span>{H(x["title_snapshot"])}</span>'+(btn('دریافت قانونی PDF','/download/'+str(x['id']),'btn light') if x['payment_status']=='paid' and x['fulfillment_status']!='cancelled' else ('<span class="muted">سفارش لغوشده</span>' if x['fulfillment_status']=='cancelled' else '<span class="muted">در انتظار تأیید پرداخت</span>'))+'</div>'
        out+='</div><div class="panel"><h2>درخواست مرجوعی</h2><p class="small muted">کد ردیف کالا را از فاکتور یا با پشتیبانی دریافت کنید.</p>'+postform('/returns/new',field('item_id','شناسه ردیف سفارش','','number',True)+area('reason','دلیل درخواست')+'<button class="btn">ارسال درخواست</button>',self.csrf)+'</div>'
        self.render(out,'حساب من')
    def account_security(self):
        if not self.require():return
        if self.user['bridge_node_id'] is not None:return self.render('<div class="panel">برای تغییر رمز حساب مدیریت، به <a href="../../panel/account">پنل اصلی ورق</a> مراجعه کنید.</div>','امنیت حساب')
        content='<h1>امنیت حساب</h1><div class="panel"><h2>تغییر رمز عبور</h2><p class="muted">برای حفاظت از حساب، رمز جدید حداقل ۱۲ کاراکتر داشته باشد. پس از تغییر، تمام نشست‌های دیگر باطل می‌شوند.</p>'+postform('/account/password',field('old_password','رمز فعلی','','password',True)+field('new_password','رمز جدید','','password',True,'minlength="12"')+field('confirm_password','تکرار رمز جدید','','password',True,'minlength="12"')+'<button class="btn">ذخیره رمز جدید</button>',self.csrf)+'</div>'
        return self.render(content,'امنیت حساب')
    def change_password(self,d):
        if not self.require():return
        if self.user['bridge_node_id'] is not None:raise ValueError('رمز این حساب فقط در پنل اصلی مدیریت تغییر می‌کند.')
        old=d.get('old_password','');new=d.get('new_password','');confirm=d.get('confirm_password','')
        if len(new)<12 or len(new)>256 or new!=confirm or new==old:raise ValueError('رمز جدید باید متفاوت، حداقل ۱۲ نویسه و با تکرار آن یکسان باشد.')
        with self.conn() as c:
            user=c.execute('SELECT passhash FROM users WHERE id=?',(self.user_id,)).fetchone()
            if not user or not verify(old,user['passhash']):raise ValueError('رمز فعلی درست نیست.')
            c.execute('UPDATE users SET passhash=? WHERE id=?',(hashpass(new),self.user_id))
            c.execute('DELETE FROM sessions WHERE user_id=? AND id<>?',(self.user_id,self.sid))
            c.execute('INSERT INTO audit_events(actor_id,action,reference,note,created) VALUES(?,?,?,?,?)',(self.user_id,'password_changed',str(self.user_id),'other sessions revoked',now()))
        return self.render('<div class="panel"><h2>رمز شما تغییر کرد ✅</h2><p>تمام نشست‌های دیگر بسته شدند.</p>'+btn('بازگشت به حساب','/account')+'</div>','تغییر رمز')
    def invoice(self,i):
        if not self.require():return
        if not i.isdigit():return self.err('فاکتور نامعتبر است.',404)
        with self.conn() as c:
            order=c.execute('SELECT * FROM orders WHERE id=?',(int(i),)).fetchone()
            if not order:return self.err('فاکتور پیدا نشد.',404)
            if order['user_id']!=self.user_id and self.user['role']!='admin':return self.err('دسترسی به فاکتور ندارید.',403)
            items=c.execute('SELECT oi.*,s.name shop_name FROM order_items oi JOIN shops s ON oi.shop_id=s.id WHERE oi.order_id=?',(int(i),)).fetchall()
        lines=''.join(f'<tr><td>{H(x["title_snapshot"])}</td><td>{H(x["shop_name"])}</td><td>#{x["id"]}</td><td>{x["qty"]}</td><td>{money(x["price"])}</td><td>{money(x["price"]*x["qty"])}</td></tr>' for x in items)
        content=f'<div class="panel"><div class="section-head"><h1>فاکتور سفارش {H(order["code"])}</h1><span class="badge-status">{H(order["payment_status"])}</span></div><p>تاریخ: {H(order["created"])} | تحویل‌گیرنده: {H(order["recipient"])} | تماس: {H(order["phone"])}</p><p>آدرس تحویل: {H(order["address"])}</p><div class="tablewrap"><table class="table"><tr><th>کتاب</th><th>فروشنده</th><th>شناسه ردیف</th><th>تعداد</th><th>واحد</th><th>جمع</th></tr>{lines}</table></div><div class="totals"><div class="rowline"><span>جمع اقلام</span><b>{money(order["subtotal"])}</b></div><div class="rowline"><span>تخفیف</span><b>{money(order["discount"])}</b></div><div class="rowline"><span>ارسال</span><b>{money(order["shipping"])}</b></div><div class="rowline"><strong>قابل پرداخت</strong><strong>{money(order["total"])}</strong></div></div><p class="muted small">برای چاپ فاکتور از گزینه Print مرورگر استفاده کنید.</p></div>'
        return self.render(content,'فاکتور '+order['code'])
    def seller_order_view(self,i,query):
        if not self.require(('seller','admin')):return
        if not i.isdigit() or not str(query.get('shop','')).isdigit():return self.err('شناسه سفارش یا فروشگاه نادرست است.',404)
        sid=int(query['shop'])
        with self.conn() as c:
            if sid not in self.seller_shopids(c):return self.err('شما به این فروشگاه دسترسی ندارید.',403)
            order=c.execute('SELECT o.*,so.status store_status FROM orders o JOIN shop_orders so ON o.id=so.order_id WHERE o.id=? AND so.shop_id=?',(int(i),sid)).fetchone()
            if not order:return self.err('سفارش فروشگاه پیدا نشد.',404)
            items=c.execute('SELECT * FROM order_items WHERE order_id=? AND shop_id=?',(int(i),sid)).fetchall()
        t=''.join(f'<tr><td>#{x["id"]}</td><td>{H(x["title_snapshot"])}</td><td>{x["qty"]}</td><td>{money(x["price"]*x["qty"])}</td></tr>' for x in items)
        content=f'<div class="panel"><h1>سفارش {H(order["code"])}</h1><p>تحویل‌گیرنده: {H(order["recipient"])} · تماس: {H(order["phone"])} · آدرس: {H(order["address"])}</p><p>وضعیت فروشگاه: {H(order["store_status"])} · وضعیت پرداخت: {H(order["payment_status"])}</p><div class="tablewrap"><table class="table"><tr><th>ردیف</th><th>کالا</th><th>تعداد</th><th>جمع</th></tr>{t}</table></div></div>'
        return self.render(content,'جزئیات سفارش فروشنده')
    def favorites(self):
        if not self.require():return
        with self.conn() as c:rows=c.execute('SELECT b.*,s.name shop_name FROM favorites f JOIN books b ON f.book_id=b.id JOIN shops s ON b.shop_id=s.id WHERE f.user_id=?',(self.user_id,)).fetchall()
        self.render('<h1>علاقه‌مندی‌ها</h1><div class="grid">'+''.join(bookcard(x,self.csrf) for x in rows)+'</div>','علاقه‌مندی‌ها')
    def support(self):
        form=field('title','عنوان درخواست','','text',True)+area('body','شرح درخواست')+'<button class="btn">ثبت درخواست</button>'
        self.render('<h1>پشتیبانی</h1><p class="muted">برای پیگیری سفارش، سوال درباره کتاب یا مشکلات دسترسی درخواست ثبت کنید.</p><div class="panel">'+(postform('/support/new',form,self.csrf) if self.user else '<p>برای ارسال درخواست ابتدا وارد شوید.</p>'+btn('ورود','/login'))+'</div>','پشتیبانی')
    def policies(self):
        self.render('<div class="panel"><h1>شرایط خرید و استفاده</h1><p>قیمت، موجودی، زمان تحویل و سیاست مرجوعی هر فروشنده پیش از نهایی شدن سفارش باید تأیید شود. فایل‌های PDF فقط با مجوز معتبر صاحب حقوق عرضه و پس از تأیید پرداخت تحویل داده می‌شوند. پرداخت آنلاین صرفاً پس از اتصال درگاه مجاز متعلق به فروشنده قابل فعال‌سازی است.</p><p>این نسخه، سیاست مرجوعی قانونی را به صورت درخواست و بررسی ثبت می‌کند؛ مبالغ و مهلت‌ها باید بر اساس قرارداد فروشنده و قوانین لازم‌الاجرا تنظیم شوند.</p></div>','قوانین')
    def download(self,i):
        if not self.require():return
        if not i.isdigit():return self.err('کتاب یافت نشد.',404)
        with self.conn() as c:
            row=c.execute("SELECT oi.*,o.user_id,o.payment_status,b.ebook,b.rights_ok FROM order_items oi JOIN orders o ON oi.order_id=o.id JOIN books b ON b.id=oi.book_id WHERE oi.id=?",(int(i),)).fetchone()
        if not row or row['user_id']!=self.user_id or row['payment_status']!='paid' or not row['rights_ok'] or row['kind'] not in ('pdf','both'):
            return self.err('مجوز دانلود برای این سفارش فراهم نیست.',403)
        with self.conn() as c:
            cancelled=c.execute('SELECT 1 FROM shop_orders WHERE order_id=? AND shop_id=? AND status=?',(row['order_id'],row['shop_id'],'cancelled')).fetchone()
        if cancelled:return self.err('این سفارش لغو شده و دسترسی به فایل متوقف شده است.',403)
        name=row['ebook'] or ''
        if not re.fullmatch(r'[a-zA-Z0-9_-]+\.pdf',name):return self.err('فایل PDF موجود نیست.',404)
        f=EBOOKS/name
        if not f.is_file():return self.err('فایل بارگذاری نشده است.',404)
        return self.binary(f.read_bytes(),'application/pdf',f'varaq-book-{i}.pdf')
    def seller_shopids(self,c):
        if self.user['role']=='admin':return [r['id'] for r in c.execute('SELECT id FROM shops')]
        if self.user['bridge_node_id'] is not None:
            return [r['id'] for r in c.execute('SELECT id FROM shops WHERE bridge_store_id=?',(self.user['bridge_store_id'],))]
        return [r['id'] for r in c.execute('SELECT id FROM shops WHERE owner_id=?',(self.user_id,))]
    def seller(self,q):
        if not self.require(('seller','admin')):return
        with self.conn() as c:
            shopids=self.seller_shopids(c)
            if not shopids:return self.err('هنوز فروشگاهی به حساب شما اختصاص داده نشده است.',403)
            requested=int(q.get('shop',shopids[0])) if str(q.get('shop',shopids[0])).isdigit() else shopids[0]
            sid=requested if requested in shopids else shopids[0]
            shop=c.execute('SELECT * FROM shops WHERE id=?',(sid,)).fetchone()
            books=c.execute('SELECT * FROM books WHERE shop_id=? ORDER BY id DESC LIMIT 300',(sid,)).fetchall()
            orders=c.execute('SELECT so.*,o.code,o.created,o.payment_status,o.payment_method,o.total,o.recipient,o.phone,o.address FROM shop_orders so JOIN orders o ON so.order_id=o.id WHERE so.shop_id=? ORDER BY o.id DESC LIMIT 100',(sid,)).fetchall()
            coupons=c.execute('SELECT * FROM coupons WHERE shop_id=? ORDER BY id DESC',(sid,)).fetchall()
            current=None
            if q.get('edit') and str(q['edit']).isdigit():current=c.execute('SELECT * FROM books WHERE id=? AND shop_id=?',(int(q['edit']),sid)).fetchone()
        nav='<div class="catlist">'+''.join(f'<a href="/seller?shop={i}" class="{"on" if i==sid else ""}">فروشگاه {i}</a>' for i in shopids)+'</div>'
        g=lambda k,default='':current[k] if current else default
        fields=field('title','عنوان کتاب',g('title'),required=True)+field('author','نویسنده',g('author'))+field('publisher','ناشر',g('publisher'))+field('isbn','شابک',g('isbn'))+field('year','سال انتشار',g('year'))+field('category','دسته‌بندی',g('category','عمومی'))+field('price','قیمت (تومان)',g('price',0),'number',True,'min="0"')+field('stock','موجودی نسخه چاپی',g('stock',0),'number',True,'min="0"')+choose('kind','نوع عرضه',[('physical','چاپی'),('pdf','PDF'),('both','هر دو')],g('kind','physical'))+choose('status','وضعیت',[('active','فعال'),('hidden','پنهان')],g('status','active'))
        fs='<input type="hidden" name="shop_id" value="'+str(sid)+'"><input type="hidden" name="book_id" value="'+str(g('id',0))+'">'+'<div class="formgrid">'+fields+'</div>'+area('description','خلاصه اختصاصی',g('description'))+'<label class="field">تصویر جلد (PNG/JPG/WEBP)<input name="cover" type="file" accept=".png,.jpg,.jpeg,.webp"></label><label class="field">فایل PDF قانونی<input name="ebook" type="file" accept=".pdf,application/pdf"></label><label class="field"><span><input type="checkbox" name="rights_ok" value="1" '+('checked' if g('rights_ok',0) else '')+'> تأیید می‌کنم مجوز نشر و فروش PDF را دارم</span></label><button class="btn">ذخیره اطلاعات کتاب</button>'
        out=f'<h1>پنل فروشنده: {H(shop["name"])}</h1>{nav}<div class="panel"><h2>{"ویرایش کتاب" if current else "افزودن کتاب"}</h2><form action="/seller/book" method="post" enctype="multipart/form-data">{csrf(self.csrf)}{fs}</form></div><div class="panel"><h2>کتاب‌ها و موجودی</h2><div class="tablewrap"><table class="table"><tr><th>عنوان</th><th>قیمت</th><th>موجودی</th><th>نوع</th><th>وضعیت</th><th></th></tr>'
        for b in books:out+=f'<tr><td>{H(b["title"])}</td><td>{money(b["price"])}</td><td>{b["stock"]}</td><td>{H(b["kind"])}</td><td>{H(b["status"])}</td><td><a href="/seller?shop={sid}&edit={b["id"]}">ویرایش</a></td></tr>'
        out+='</table></div></div><div class="panel"><h2>سفارش‌های فروشگاه</h2><div class="tablewrap"><table class="table"><tr><th>کد</th><th>خریدار</th><th>شماره</th><th>پرداخت</th><th>وضعیت ارسال</th><th>اقدام</th></tr>'
        for x in orders:
            transitions={'new':['preparing','shipped','cancelled'], 'preparing':['shipped','cancelled'],
                         'shipped':['delivered'], 'delivered':[], 'cancelled':[]}
            opts={'preparing':'آماده‌سازی','shipped':'ارسال شد','delivered':'تحویل شد','cancelled':'لغو شد'}
            next_states=list(transitions.get(x['status'],[]))
            if x['payment_status']=='paid':next_states=[z for z in next_states if z!='cancelled']
            if x['payment_method']=='manual' and x['payment_status']!='paid':
                next_states=[z for z in next_states if z not in ('shipped','delivered')]
            next_options=[(z,opts[z]) for z in next_states]
            f=(f'<input type="hidden" name="order_id" value="{x["order_id"]}"><input type="hidden" name="shop_id" value="{sid}">'+choose('status','مرحله بعد',next_options)+'<button class="btn smallbtn">ثبت</button>') if next_options else '<span class="muted small">اقدام بعدی ندارد</span>'
            payment='تأییدشده' if x['payment_status']=='paid' else ('هنگام تحویل' if x['payment_method']=='cod' else 'در انتظار تأیید')
            out+=f'<tr><td><a href="/seller/order/{x["order_id"]}?shop={sid}">{H(x["code"])}</a></td><td>{H(x["recipient"])}</td><td>{H(x["phone"])}</td><td>{H(payment)}</td><td>{H(x["status"])}</td><td>{postform("/seller/order",f,self.csrf) if next_options else f}</td></tr>'
        out+='</table></div></div><div class="panel"><h2>کدهای تخفیف</h2>'
        cform=f'<input type="hidden" name="shop_id" value="{sid}">'+field('code','کد با پیشوند فروشگاه',shop['slug'].upper()+'_','text',True)+choose('kind','نوع',[('percent','درصدی'),('fixed','مبلغ ثابت')])+field('value','مقدار',10,'number',True,'min="1"')+field('max_uses','سقف استفاده (صفر یعنی نامحدود)',0,'number')+field('expires','تاریخ انقضا YYYY-MM-DD (اختیاری)')+'<button class="btn">ایجاد کوپن</button>'
        out+=postform('/seller/coupon','<div class="formgrid">'+cform+'</div>',self.csrf)+'<div class="tablewrap"><table class="table"><tr><th>کد</th><th>مقدار</th><th>استفاده</th></tr>'+''.join(f'<tr><td>{H(x["code"])}</td><td>{H(x["value"])} {"٪" if x["kind"]=="percent" else "تومان"}</td><td>{x["uses"]}</td></tr>' for x in coupons)+'</table></div></div>'
        self.render(out,'پنل فروشنده')
    def admin(self,q):
        if not self.require(('admin',)):return
        with self.conn() as c:
            stats={'books':c.execute('SELECT COUNT(*) n FROM books').fetchone()['n'],'users':c.execute('SELECT COUNT(*) n FROM users').fetchone()['n'],'orders':c.execute('SELECT COUNT(*) n FROM orders').fetchone()['n'],'shops':c.execute('SELECT COUNT(*) n FROM shops').fetchone()['n']}
            shops=c.execute('SELECT s.*,u.username FROM shops s LEFT JOIN users u ON s.owner_id=u.id').fetchall()
            users=c.execute('SELECT id,username,role FROM users ORDER BY id DESC LIMIT 200').fetchall()
            payments=c.execute('''SELECT o.* FROM orders o WHERE o.payment_status='unpaid' AND o.payment_method='manual'
                AND NOT EXISTS (SELECT 1 FROM shop_orders so WHERE so.order_id=o.id AND so.status='cancelled')
                ORDER BY o.id DESC LIMIT 90''').fetchall()
            reviews=c.execute('SELECT r.*,b.title,u.username FROM reviews r JOIN books b ON b.id=r.book_id JOIN users u ON u.id=r.user_id WHERE approved=0 ORDER BY r.id DESC LIMIT 40').fetchall()
            returns=c.execute('SELECT r.*,oi.title_snapshot FROM returns r JOIN order_items oi ON oi.id=r.order_item_id ORDER BY r.id DESC LIMIT 40').fetchall()
            tickets=c.execute('SELECT t.*,u.username FROM tickets t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 50').fetchall()
        out='<h1>مدیریت کل ورق</h1><p>'+btn('گزارش ادغام و سلامت کتاب‌ها','/admin/migration','btn light')+' '+btn('ممیزی موجودی و سفارش‌های دو سامانه','/admin/integration','btn light')+' '+btn('پیوند مستقیم کتاب‌ها','/admin/catalog-links','btn light')+'</p><div class="cols">'+''.join(f'<div class="panel"><h2>{v}</h2><p class="muted">{H(k)}</p></div>' for k,v in stats.items())+'</div>'
        out+='<div class="panel"><h2>فروشگاه‌ها</h2><div class="tablewrap"><table class="table"><tr><th>فروشگاه</th><th>مدیر</th><th>وضعیت</th></tr>'+''.join(f'<tr><td>{H(s["name"])} ({H(s["slug"])})</td><td>{H(s["username"])}</td><td>{"فعال" if s["active"] else "غیرفعال"}</td></tr>' for s in shops)+'</table></div>'
        sf=field('name','نام فروشگاه','','text',True)+field('slug','شناسه یکتا (لاتین)','','text',True)+choose('owner_id','کاربر مسئول',[(x['id'],x['username']) for x in users])+area('description','توضیح')+'<button class="btn">ایجاد فروشگاه</button>'
        out+=postform('/admin/shop','<div class="formgrid">'+sf+'</div>',self.csrf)+'</div><div class="panel"><h2>نقش کاربران</h2>'
        uf=choose('user_id','کاربر',[(x['id'],x['username']) for x in users])+choose('role','نقش',[('customer','مشتری'),('seller','فروشنده')])+'<button class="btn">تنظیم نقش</button>'
        out+=postform('/admin/user',uf,self.csrf)+'</div><div class="panel"><h2>تأیید دستی پرداخت‌های مستند</h2><p class="muted small">فقط پس از مشاهده رسید و بررسی واقعی تسویه تأیید شود. فروشنده مجوز تأیید پرداخت را از این پنل ندارد.</p><div class="tablewrap"><table class="table"><tr><th>کد</th><th>خریدار</th><th>جمع کل</th><th>اقدام</th></tr>'
        for x in payments:
            cf=f'<input type="hidden" name="order_id" value="{x["id"]}"><label class="field">تأیید بررسی واقعی پرداخت<input name="proof" placeholder="شماره پیگیری پرداخت" required></label><button class="btn smallbtn">تأیید پرداخت</button>'
            out+=f'<tr><td>{H(x["code"])}</td><td>{H(x["recipient"])}</td><td>{money(x["total"])}</td><td>{postform("/admin/payment",cf,self.csrf)}</td></tr>'
        out+='</table></div>'+btn('خروجی CSV سفارش‌ها','/admin/export','btn light')+'</div>'
        out+='<div class="panel"><h2>بررسی نظرها</h2>'
        for x in reviews:
            cf=f'<input type="hidden" name="review_id" value="{x["id"]}"><button class="btn smallbtn">تأیید نظر</button>'
            out+=f'<div class="rowline"><span>{H(x["username"])} درباره {H(x["title"])}: {H(x["body"])}</span>{postform("/admin/review",cf,self.csrf)}</div>'
        out+='</div><div class="panel"><h2>درخواست‌های مرجوعی</h2>'
        for x in returns:
            cf=f'<input type="hidden" name="return_id" value="{x["id"]}">'+choose('status','',[('requested','در انتظار'),('approved','تأیید شد'),('rejected','رد شد'),('completed','انجام شد')],x['status'])+'<button class="btn smallbtn">ثبت وضعیت</button>'
            out+=f'<div class="rowline"><span>{H(x["title_snapshot"])}: {H(x["reason"])} | {H(x["status"])}</span>{postform("/admin/return",cf,self.csrf)}</div>'
        out+='</div><div class="panel"><h2>درخواست‌های پشتیبانی</h2>'+''.join(f'<p>#{x["id"]} | {H(x["username"])} | {H(x["title"])} — {H(x["body"])}</p>' for x in tickets)+'</div>'
        out+='<div class="panel"><h2>ورود فهرست کتاب از CSV / JSON</h2><p class="muted small">ستون‌های قابل پذیرش: title, author, publisher, isbn, year, category, description, price, stock, kind, cover, ebook. تصاویر را جداگانه در assets/covers کپی کنید. اطلاعات موجود حذف نمی‌شوند.</p><form method="post" action="/admin/import" enctype="multipart/form-data">'+csrf(self.csrf)+choose('shop_id','فروشگاه',[(x['id'],x['name']) for x in shops])+'<label class="field">فایل داده<input type="file" name="catalog" accept=".csv,.json" required></label><button class="btn">درون‌ریزی کتاب‌ها</button></form></div>'
        self.render(out,'پنل مدیریت')
    def catalog_link_status(self):
        if not self.require(('admin',)):return
        with self.conn() as c:
            linked=c.execute('SELECT COUNT(*) FROM catalog_identity_links').fetchone()[0]
            books=c.execute('SELECT COUNT(*) FROM books').fetchone()[0]
        path=DATA/'reports'/'catalog_identity_v98.json'
        content='<h1>پیوند کتاب‌های مرجع و فروشگاه</h1><div class="cols"><div class="panel"><h2>'+str(linked)+'</h2><p>پیوند دقیق ثبت‌شده</p></div><div class="panel"><h2>'+str(books)+'</h2><p>کتاب در فروشگاه</p></div></div>'
        content+='<div class="panel"><h2>اصول اتصال</h2><p>تطبیق فقط با عنوان و نویسنده یکتای هر کتاب انجام می‌شود. نام‌های مبهم، اختلاف شابک و تغییرات هویتی برای بررسی مدیر باقی می‌مانند. قیمت، موجودی و سفارش‌های مالی منتقل نمی‌شوند.</p></div>'
        try:
            if not path.is_file():
                return self.render(content+'<div class="panel">گزارش هنوز تولید نشده است. برنامه را با START_UNIFIED_WINDOWS.bat اجرا کنید یا CATALOG_LINK_AUDIT_WINDOWS.bat را بزنید.</div>','پیوند کتاب‌ها')
            if path.stat().st_size>2_000_000:raise ValueError('oversized')
            result=json.loads(path.read_text(encoding='utf-8'))
            if result.get('version')!='9.8':raise ValueError('wrong report')
            summary=result.get('summary_after') or result.get('summary') or {}
            content+='<div class="panel"><h2>آخرین ممیزی</h2><p>تاریخ: '+H(result.get('generated_utc',''))+' · وضعیت: '+H(result.get('mode',''))+'</p>'
            for k,label in [('healthy_existing_links','پیوندهای بدون هشدار'),('new_unambiguous_links','پیشنهادهای جدید'),('needs_manual_review','کتاب‌های مبهم'),('existing_links_needing_review','پیوندهای تغییرکرده')]:
                content+='<div class="rowline"><span>'+label+'</span><strong>'+str(int(summary.get(k,0)))+'</strong></div>'
            content+='</div>'
            flagged=(result.get('manual_review') or [])+(result.get('link_drift') or [])
            if flagged:
                content+='<div class="panel"><h2>موارد نیازمند بررسی</h2><p class="muted small">این موارد خودکار تأیید نمی‌شوند.</p><div class="tablewrap"><table class="table"><tr><th>کتاب مرجع</th><th>علت</th></tr>'
                for item in flagged[:50]:
                    content+='<tr><td>'+H(item.get('node_book_id'))+' · '+H(item.get('title',''))+'</td><td>'+H(item.get('issue',''))+'</td></tr>'
                content+='</table></div></div>'
        except (OSError,ValueError,TypeError,json.JSONDecodeError):
            content+='<div class="panel">گزارش پیوندها خراب یا نامعتبر است؛ ممیزی را دوباره اجرا کنید.</div>'
        self.render(content,'پیوند کتاب‌ها')

    def legacy_book_link(self, identifier):
        """Exact legacy editorial -> retail link. Never guess by a shared numeric ID."""
        if not re.fullmatch(r'[1-9][0-9]{0,8}',identifier):
            return self.err('شناسه کتاب نامعتبر است.',404)
        if os.environ.get('VARAQ_CATALOG_LINK_PENDING')=='1' and not (DATA/'.catalog_identity_ready').exists():
            return self.err('ارتباط بین کتاب‌ها در حال آماده‌سازی است. لطفاً پس از تکمیل راه‌اندازی دوباره تلاش کنید.',503)
        with self.conn() as c:
            row=c.execute('''SELECT l.retail_book_id, b.status, s.active
                FROM catalog_identity_links l JOIN books b ON l.retail_book_id=b.id
                JOIN shops s ON s.id=b.shop_id WHERE l.node_book_id=?''',(int(identifier),)).fetchone()
        if not row or row['status']!='active' or not row['active']:
            return self.err('برای این کتاب هنوز پیوند فروشگاهی تأییدشده‌ای وجود ندارد.',404)
        return self.redirect('/book/'+str(row['retail_book_id']))

    def integration_status(self):
        # Read-only view of a report generated locally with AUDIT_INTEGRATION_WINDOWS.bat.
        if not self.require(('admin',)):return
        reportfile=DATA/'reports'/'audit_v97.json'
        if not reportfile.is_file():
            return self.render('<div class="panel"><h1>ممیزی یکپارچگی</h1><p>گزارش هنوز ایجاد نشده است. از پوشه اصلی، AUDIT_INTEGRATION_WINDOWS.bat را بعد از راه‌اندازی سایت اجرا کنید.</p></div>','ممیزی دو دفتر')
        try:
            if reportfile.stat().st_size>2_000_000:raise ValueError('large report')
            x=json.loads(reportfile.read_text(encoding='utf-8'))
            if x.get('version')!='9.7' or not isinstance(x.get('summary'),dict):raise ValueError('old report')
        except (OSError,ValueError,json.JSONDecodeError):
            return self.err('گزارش معتبر نیست؛ ممیزی را دوباره اجرا کنید.',422)
        fields=[('node_books','کتاب‌های مرجع'),('retail_books','کتاب‌های فروشگاه'),
          ('old_node_demo_orders','سفارش‌های تاریخی نمایشی'),('retail_orders','سفارش‌های فروشگاه جدید'),
          ('missing_books_in_retail','کتاب‌های واردنشده'),('different_book_titles','اختلاف عنوان‌ها'),
          ('inventory_disagreements','مغایرت موجودی دو دفتر'),('unmapped_retail_shops','فروشگاه‌های بدون نگاشت')]
        t=''.join(f'<div class="rowline"><span>{H(title)}</span><strong>{int(x["summary"].get(k,0)):,}</strong></div>' for k,title in fields)
        msg='<div class="panel"><h1>ممیزی یکپارچگی نسخه ۹.۷</h1><p class="muted small">آخرین گزارش: '+H(x.get('generated_at_utc','نامشخص'))+'</p><p>سفارش‌ها و موجودی‌های قدیمی صرفاً برای مقایسه نگه داشته می‌شوند. این گزارش هیچ داده‌ای را تغییر نمی‌دهد.</p>'+t+'</div>'
        link_report=DATA/'reports'/'catalog_identity_v98.json'
        if link_report.is_file():
            try:
                if link_report.stat().st_size>1_000_000:raise ValueError('oversized')
                z=json.loads(link_report.read_text(encoding='utf-8'))
                if z.get('version')!='9.8' or not isinstance(z.get('summary'),dict):raise ValueError('old data')
                with self.conn() as c:
                    linked=c.execute('SELECT COUNT(*) FROM catalog_identity_links').fetchone()[0]
                msg+='<div class="panel"><h2>پیوند دقیق کتاب‌های مرجع به فروشگاه — نسخه ۹.۸</h2><p>پیوندهای ثبت‌شده: <strong>'+str(linked)+'</strong> · موارد مبهم: '+str(int(z['summary'].get('needs_manual_review',0)))+' · پیوندهای نیازمند بررسی: '+str(int(z['summary'].get('existing_links_needing_review',0)))+'</p><p class="muted small">فقط شناسه کتاب متصل می‌شود؛ هیچ قیمت، موجودی، سفارش یا حساب مشتری انتقال پیدا نکرده است. خروجی مربوط به آخرین اجرای ابزار است.</p></div>'
            except (OSError,ValueError,sqlite3.Error,json.JSONDecodeError):
                msg+='<div class="panel">گزارش پیوند کتاب‌ها نامعتبر است؛ ابزار ممیزی را دوباره اجرا کنید.</div>'
        return self.render(msg,'ممیزی دو دفتر')

    def migration_status(self):
        if not self.require(('admin',)):return
        from CATALOG_AUDIT import report as audit_catalog
        m=audit_catalog()
        total=m.get('book_count',0);covers=m.get('covers_present',0);summaries=m.get('summaries_present',0)
        legacy=m.get('legacy_merge') or {}
        last='<p class="muted">هنوز گزارشی از ادغام موفق فایل قدیمی در این نصب ثبت نشده است.</p>'
        if legacy.get('status')=='applied':
            last=f'<p>ادغام در تاریخ {H(legacy.get("applied_at") or "نامشخص")} ثبت شده است. {int(legacy.get("inserted") or 0)} کتاب جدید.</p>'
            last+=f'<p class="small muted">اثر انگشت آرشیو: <code>{H(legacy.get("source_sha256") or "ثبت نشده")}</code></p>'
        issues=(f'<p>جلد پیدا نشده: <b>{m.get("missing_cover_count",0):,}</b> · معرفی کوتاه/ناقص: <b>{m.get("missing_summary_count",0):,}</b> · '
                f'PDF فاقد مجوز یا فایل معتبر: <b>{m.get("missing_pdf_or_rights_count",0):,}</b> · شابک تکراری: <b>{m.get("duplicate_isbn_count",0):,}</b></p>')
        view=(f'<h1>گزارش سلامت و ادغام کتاب‌ها</h1><div class="cols"><div class="panel"><h2>{total:,}</h2><p>کتاب موجود</p></div>'
              f'<div class="panel"><h2>{covers:,}</h2><p>جلد فایل‌دار</p></div><div class="panel"><h2>{summaries:,}</h2><p>دارای معرفی</p></div></div>'
              f'<div class="panel"><h2>کنترل کیفیت</h2><p>سلامت SQLite: {H(m.get("database_integrity","نامشخص"))} · وضعیت: {H(m["status"])}</p>{issues}'
              f'{btn("دانلود گزارش JSON","/admin/catalog/audit.json","btn outline")} '
              f'{btn("خروجی CSV کتاب‌ها","/admin/catalog/export","btn light")}</div>'
              f'<div class="panel"><h2>منشأ نسخه ۸.۶</h2>{last}<p class="small muted">این صفحه به‌تنهایی اثبات صحت فهرست چاپ‌ها یا مجوز تصاویر نیست. '
              'حساب‌ها، سفارش‌ها، فروشندگان و ماژول‌های اختصاصی Node نسخه ۸.۶ هنوز به هسته Python انتقال پیدا نکرده‌اند.</p></div>')
        return self.render(view,'گزارش ادغام')

    def catalog_audit_json(self):
        if not self.require(('admin',)):return
        from CATALOG_AUDIT import report as audit_catalog
        return self.binary(json.dumps(audit_catalog(),ensure_ascii=False,indent=2).encode('utf-8'),'application/json; charset=utf-8','varaq-catalog-audit.json')

    def export_catalog(self):
        if not self.require(('admin',)):return
        with self.conn() as c:
            rows=c.execute('''SELECT id,shop_id,title,author,publisher,isbn,year,category,description,price,stock,kind,cover,rights_ok,status,created,updated
                              FROM books ORDER BY shop_id,id''').fetchall()
        out=io.StringIO();cols=['id','shop_id','title','author','publisher','isbn','year','category','description','price','stock','kind','cover','rights_ok','status','created','updated']
        w=csv.writer(out);w.writerow(cols)
        # Spreadsheet formula injection protection for book titles and descriptions.
        def safe_cell(value):
            if isinstance(value,str) and value.lstrip().startswith(('=','+','-','@','\t','\r')):
                return "'"+value
            return value
        for b in rows:w.writerow([safe_cell(b[key]) for key in cols])
        return self.binary(('\ufeff'+out.getvalue()).encode('utf-8'),'text/csv; charset=utf-8','varaq-catalog.csv')
    def sitemap(self):
        with self.conn() as c:books=c.execute("SELECT id FROM books WHERE status='active' ORDER BY id DESC LIMIT 50000").fetchall()
        path=['/','/books','/shops']+[f'/book/{x["id"]}' for x in books]
        xml='<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+''.join('<url><loc>'+H(PUBLIC_URL+p)+'</loc></url>' for p in path)+'</urlset>'
        return self.binary(xml.encode(),'application/xml')
    def api_books(self,q):
        try:limit=min(100,max(1,int(q.get('limit','20'))))
        except:limit=20
        with self.conn() as c:
            items=c.execute("SELECT b.id,b.title,b.author,b.category,b.price,b.kind,b.stock,s.name seller FROM books b JOIN shops s ON b.shop_id=s.id WHERE b.status='active' AND s.active=1 ORDER BY b.id DESC LIMIT ?",(limit,)).fetchall()
        return self.binary(json.dumps({'results':[dict(x) for x in items]},ensure_ascii=False).encode(),'application/json; charset=utf-8')
    def register(self,d):
        u=d.get('username','').strip();p=d.get('password','');email=d.get('email','').strip()
        if not re.fullmatch(r'[A-Za-z0-9_\u0600-\u06ff.\-]{3,40}',u):raise ValueError('نام کاربری نامعتبر است.')
        if len(p)<12:raise ValueError('رمز باید دست‌کم ۱۲ نویسه باشد.')
        with self.conn() as c:
            if c.execute('SELECT id FROM users WHERE username=?',(u,)).fetchone():raise ValueError('این نام کاربری قبلاً ثبت شده است.')
            c.execute('INSERT INTO users(username,email,passhash,role,created) VALUES(?,?,?,?,?)',(u,email,hashpass(p),'customer',now()))
            self.attach_user(c.execute('SELECT id FROM users WHERE username=?',(u,)).fetchone()['id'],c)
        return self.redirect('/account')
    def attach_user(self,uid,c):
        # Rotate session identifier after privilege transition to prevent session fixation.
        new_sid=secrets.token_hex(24);new_csrf=secrets.token_urlsafe(32)
        c.execute('UPDATE sessions SET id=?,user_id=?,csrf=? WHERE id=?',(new_sid,uid,new_csrf,self.sid))
        self.sid=new_sid;self.csrf=new_csrf;self.user_id=uid
    def login(self,d):
        with self.conn() as c:
            row=c.execute('SELECT * FROM users WHERE username=?',(d.get('username',''),)).fetchone()
            if not row or not verify(d.get('password',''),row['passhash']):raise ValueError('نام کاربری یا گذرواژه نادرست است.')
            self.attach_user(row['id'],c)
        return self.redirect('/account')
    def logout(self,d):
        with self.conn() as c:
            c.execute('UPDATE sessions SET user_id=NULL,cart_json="{}" WHERE id=?',(self.sid,))
            c.execute('UPDATE sessions SET csrf=? WHERE id=?',(secrets.token_urlsafe(32),self.sid))
        return self.redirect('/')
    def cart_add(self,d):
        bid=d.get('book_id','')
        if not bid.isdigit():raise ValueError('کتاب نامعتبر است.')
        with self.conn() as c:
            b=getbook(c,int(bid))
        if not b or b['status']!='active':raise ValueError('کتاب موجود نیست.')
        with self.conn() as c:
            if not c.execute('SELECT 1 FROM shops WHERE id=? AND active=1',(b['shop_id'],)).fetchone():raise ValueError('فروشگاه غیرفعال است.')
        qty=min(50,max(1,int(d.get('qty','1'))))
        if b['kind']!='pdf' and b['stock']<qty:raise ValueError('موجودی کتاب کافی نیست.')
        newqty=min(50,int(self.cart.get(bid,0))+qty)
        if b['kind']!='pdf' and b['stock']<newqty:raise ValueError('تعداد درخواستی بیشتر از موجودی است.')
        self.cart[bid]=newqty
        self.save_cart();return self.redirect('/cart')
    def cart_update(self,d):
        bid=d.get('book_id','');qty=max(0,min(50,int(d.get('qty','0'))))
        if qty:
            with self.conn() as c:
                b=getbook(c,int(bid)) if bid.isdigit() else None
                if not b or b['status']!='active' or (b['kind']!='pdf' and b['stock']<qty):raise ValueError('موجودی برای این تعداد کافی نیست.')
            self.cart[bid]=qty
        else:self.cart.pop(bid,None)
        self.save_cart();return self.redirect('/cart')
    def place_order(self,d):
        if not self.require():return
        rows=self.cart_rows()
        if not rows:raise ValueError('سبد خرید خالی است.')
        recipient=d.get('recipient','').strip()[:100];phone=d.get('phone','').strip()[:30];address=d.get('address','').strip()[:800]
        if len(recipient)<2 or len(phone)<7:raise ValueError('نام و شماره تماس معتبر وارد کنید.')
        method=d.get('method','manual')
        if method not in ('cod','manual'):raise ValueError('روش پرداخت نامعتبر است.')
        if method=='cod' and any(b['kind'] in ('pdf','both') for b,q in rows):raise ValueError('برای سفارش دارای PDF پرداخت هنگام تحویل قابل انتخاب نیست.')
        if any(b['kind']!='pdf' for b,q in rows) and len(address)<8:raise ValueError('آدرس تحویل چاپی را تکمیل کنید.')
        coupon_code=d.get('coupon','').strip().upper()
        with self.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            # Always re-read price and availability while transaction lock is held.
            latest=[]
            for b,q in rows:
                fresh=getbook(c,b['id'])
                if not fresh or fresh['status']!='active':raise ValueError('یکی از کتاب‌ها دیگر قابل سفارش نیست.')
                if not c.execute('SELECT 1 FROM shops WHERE id=? AND active=1',(fresh['shop_id'],)).fetchone():raise ValueError('فروشگاه کتاب فعال نیست.')
                if fresh['kind']!='pdf' and fresh['stock']<q:raise ValueError('موجودی کافی برای '+fresh['title']+' وجود ندارد.')
                latest.append((fresh,q))
            subtotal=sum(b['price']*q for b,q in latest)
            physical_shops={b['shop_id'] for b,q in latest if b['kind']!='pdf'}
            shipping=0 if subtotal>=FREE_SHIPPING_FROM else SHIPPING_PER_SHOP*len(physical_shops)
            disc=0;coupon=None
            if coupon_code:
                coupon=c.execute('SELECT * FROM coupons WHERE code=? AND active=1',(coupon_code,)).fetchone()
                if not coupon or (coupon['expires'] and coupon['expires']<datetime.date.today().isoformat()) or (coupon['max_uses'] and coupon['uses']>=coupon['max_uses']):raise ValueError('کد تخفیف معتبر یا فعال نیست.')
                eligible=sum(b['price']*q for b,q in latest if b['shop_id']==coupon['shop_id'])
                if not eligible:raise ValueError('این کد فقط برای فروشگاه صادرکننده آن معتبر است.')
                disc=min(eligible,(eligible*min(100,coupon['value'])//100) if coupon['kind']=='percent' else coupon['value'])
            code='VQ-'+datetime.datetime.now().strftime('%y%m%d')+'-'+secrets.token_hex(3).upper()
            c.execute('INSERT INTO orders(code,user_id,recipient,phone,address,subtotal,discount,shipping,total,payment_method,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(code,self.user_id,recipient,phone,address,subtotal,disc,shipping,subtotal-disc+shipping,method,now()))
            oid=c.execute('SELECT last_insert_rowid() id').fetchone()['id']
            shops=set()
            for b,q in latest:
                c.execute('INSERT INTO order_items(order_id,shop_id,book_id,title_snapshot,price,qty,kind) VALUES(?,?,?,?,?,?,?)',(oid,b['shop_id'],b['id'],b['title'],b['price'],q,b['kind']))
                if b['kind']!='pdf':c.execute('UPDATE books SET stock=stock-?,updated=? WHERE id=?',(q,now(),b['id']))
                shops.add(b['shop_id'])
            for sid in shops:c.execute('INSERT INTO shop_orders(order_id,shop_id) VALUES(?,?)',(oid,sid))
            if coupon:c.execute('UPDATE coupons SET uses=uses+1 WHERE id=?',(coupon['id'],))
        self.cart={};self.save_cart()
        return self.render(f'<div class="panel"><h1>سفارش ثبت شد ✅</h1><p>شماره پیگیری: <strong>{H(code)}</strong></p><p>جمع قابل پرداخت: <b>{money(subtotal-disc+shipping)}</b></p><p>وضعیت پرداخت: در انتظار تأیید. بدون پرداخت تأییدشده، فایل دیجیتال تحویل نمی‌شود.</p>{btn("مشاهده سفارش‌ها","/account")}</div>','سفارش ثبت شد')
    def fav_toggle(self,d):
        if not self.require():return
        bid=int(d.get('book_id','0'))
        with self.conn() as c:
            exists=c.execute('SELECT 1 FROM favorites WHERE user_id=? AND book_id=?',(self.user_id,bid)).fetchone()
            if exists:c.execute('DELETE FROM favorites WHERE user_id=? AND book_id=?',(self.user_id,bid))
            else:c.execute('INSERT OR IGNORE INTO favorites(user_id,book_id) VALUES(?,?)',(self.user_id,bid))
        return self.redirect('/book/'+str(bid))
    def review_add(self,d):
        if not self.require():return
        bid=int(d.get('book_id','0'));score=int(d.get('score','5'));body=d.get('body','').strip()[:2000]
        if not 1<=score<=5 or not body:raise ValueError('امتیاز و متن نظر را تکمیل کنید.')
        with self.conn() as c:c.execute('INSERT INTO reviews(user_id,book_id,score,body,created) VALUES(?,?,?,?,?)',(self.user_id,bid,score,body,now()))
        return self.redirect('/book/'+str(bid))
    def ticket_add(self,d):
        if not self.require():return
        title=d.get('title','').strip()[:120];body=d.get('body','').strip()[:3000]
        if not title or not body:raise ValueError('عنوان و شرح درخواست الزامی است.')
        with self.conn() as c:c.execute('INSERT INTO tickets(user_id,title,body,created) VALUES(?,?,?,?)',(self.user_id,title,body,now()))
        return self.render('<div class="panel"><h2>درخواست شما ثبت شد</h2>'+btn('بازگشت','/account')+'</div>')
    def return_request(self,d):
        if not self.require():return
        item=int(d.get('item_id','0'));reason=d.get('reason','').strip()[:1200]
        if len(reason)<5:raise ValueError('دلیل درخواست را بنویسید.')
        with self.conn() as c:
            own=c.execute('SELECT 1 FROM order_items oi JOIN orders o ON oi.order_id=o.id WHERE oi.id=? AND o.user_id=?',(item,self.user_id)).fetchone()
            if not own:raise ValueError('این مورد متعلق به سفارش‌های شما نیست.')
            c.execute('INSERT INTO returns(order_item_id,user_id,reason,created) VALUES(?,?,?,?)',(item,self.user_id,reason,now()))
        return self.redirect('/account')
    def upload(self,files,key,kind):
        if key not in files:return ''
        name,content=files[key]
        ext=Path(name).suffix.lower()
        if kind=='cover':
            if ext not in ('.png','.jpg','.jpeg','.webp','.svg'):raise ValueError('فرمت جلد پذیرفته نیست.')
            # SVG from untrusted users may contain script/active content. Disallow SVG uploads.
            if ext=='.svg':raise ValueError('برای امنیت، جلد SVG را به PNG تبدیل کنید.')
            sig=content[:16]
            if ext=='.png' and not sig.startswith(b'\x89PNG\r\n\x1a\n'):raise ValueError('PNG نامعتبر است.')
            if ext in ('.jpg','.jpeg') and not sig.startswith(b'\xff\xd8\xff'):raise ValueError('JPG نامعتبر است.')
            if ext=='.webp' and not (sig.startswith(b'RIFF') and sig[8:12]==b'WEBP'):raise ValueError('WEBP نامعتبر است.')
            folder=COVERS
        else:
            if ext!='.pdf' or not content.startswith(b'%PDF-'):raise ValueError('فایل PDF نامعتبر است.')
            folder=EBOOKS
        if len(content)>25*1024*1024:raise ValueError('حجم هر فایل حداکثر ۲۵ مگابایت است.')
        new=secrets.token_hex(16)+ext
        (folder/new).write_bytes(content)
        return new
    def book_save(self,d,files):
        if not self.require(('seller','admin')):return
        sid=int(d.get('shop_id','0'));bid=int(d.get('book_id','0'))
        with self.conn() as c:
            if sid not in self.seller_shopids(c):return self.err('فروشگاه متعلق به شما نیست.',403)
            previous=c.execute('SELECT * FROM books WHERE id=? AND shop_id=?',(bid,sid)).fetchone() if bid else None
            if bid and not previous:raise ValueError('کتاب برای ویرایش یافت نشد.')
        title=d.get('title','').strip()[:240];kind=d.get('kind','physical');status=d.get('status','active')
        price=int(d.get('price',0));stock=int(d.get('stock',0))
        if len(title)<2 or kind not in ('physical','pdf','both') or status not in ('active','hidden') or min(price,stock)<0:raise ValueError('عنوان، قیمت یا وضعیت نامعتبر است.')
        rights=1 if d.get('rights_ok')=='1' else 0
        oldcover=previous['cover'] if previous else '';oldebook=previous['ebook'] if previous else ''
        newcover=self.upload(files,'cover','cover') or oldcover
        newebook=self.upload(files,'ebook','ebook') or oldebook
        if kind in ('pdf','both') and (not rights or not newebook):raise ValueError('برای فروش PDF، فایل و تأیید مالکیت حقوق نشر ضروری است.')
        vals=(sid,title,d.get('author','')[:180],d.get('publisher','')[:180],d.get('isbn','')[:30],d.get('year','')[:15],d.get('category','عمومی')[:75],d.get('description','')[:9000],price,stock,kind,newcover,newebook,rights,slug(title),status,now())
        with self.conn() as c:
            if previous:
                c.execute('UPDATE books SET shop_id=?,title=?,author=?,publisher=?,isbn=?,year=?,category=?,description=?,price=?,stock=?,kind=?,cover=?,ebook=?,rights_ok=?,slug=?,status=?,updated=? WHERE id=?',vals+(bid,))
            else:c.execute('INSERT INTO books(shop_id,title,author,publisher,isbn,year,category,description,price,stock,kind,cover,ebook,rights_ok,slug,status,updated,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',vals+(now(),))
        return self.redirect('/seller?shop='+str(sid))
    def coupon_save(self,d):
        if not self.require(('seller','admin')):return
        sid=int(d.get('shop_id','0'));code=d.get('code','').strip().upper()[:45]
        with self.conn() as c:
            if sid not in self.seller_shopids(c):return self.err('فروشگاه شما نیست.',403)
            shop=c.execute('SELECT slug FROM shops WHERE id=?',(sid,)).fetchone()
            if not re.fullmatch(r'[A-Z0-9_\-]{3,45}',code) or not code.startswith(shop['slug'].upper()+'_'):raise ValueError('کد باید با شناسه لاتین فروشگاه و زیرخط شروع شود.')
            kind=d.get('kind','percent');value=int(d.get('value','0'));m=int(d.get('max_uses','0'));exp=d.get('expires','')
            if kind not in ('fixed','percent') or value<1 or (kind=='percent' and value>100) or m<0 or (exp and not re.fullmatch(r'\d{4}-\d{2}-\d{2}',exp)):raise ValueError('تنظیمات کد تخفیف معتبر نیست.')
            c.execute('INSERT INTO coupons(shop_id,code,kind,value,max_uses,expires) VALUES(?,?,?,?,?,?)',(sid,code,kind,value,m,exp))
        return self.redirect('/seller?shop='+str(sid))
    def seller_order_update(self,d):
        if not self.require(('seller','admin')):return
        sid=int(d.get('shop_id','0'));oid=int(d.get('order_id','0'));status=d.get('status','')
        allowed={'new':{'preparing','shipped','cancelled'},
                 'preparing':{'shipped','cancelled'},
                 'shipped':{'delivered'},'delivered':set(),'cancelled':set()}
        if status not in ('new','preparing','shipped','delivered','cancelled'):raise ValueError('وضعیت نامعتبر است.')
        with self.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            if sid not in self.seller_shopids(c):return self.err('دسترسی ندارید.',403)
            previous=c.execute("SELECT so.status,o.payment_status,o.payment_method FROM shop_orders so "
                                  "JOIN orders o ON o.id=so.order_id WHERE so.order_id=? AND so.shop_id=?",(oid,sid)).fetchone()
            if not previous:raise ValueError('سفارش متعلق به این فروشگاه نیست.')
            old=previous['status']
            if old==status:return self.redirect('/seller?shop='+str(sid))
            if status not in allowed[old]:raise ValueError('تغییر وضعیت سفارش در این مرحله مجاز نیست.')
            if status in ('shipped','delivered') and previous['payment_method']=='manual' and previous['payment_status']!='paid':
                raise ValueError('سفارش با پرداخت هماهنگی‌شده، پیش از تأیید واقعی وجه قابل ارسال نیست.')
            if status=='cancelled' and previous['payment_status']=='paid':
                raise ValueError('لغو سفارش پرداخت‌شده نیازمند رسیدگی مالی و ثبت بازپرداخت توسط مدیر است.')
            if status=='cancelled':
                items=c.execute('SELECT * FROM order_items WHERE order_id=? AND shop_id=?',(oid,sid)).fetchall()
                for item in items:
                    if item['kind']!='pdf':c.execute('UPDATE books SET stock=stock+?,updated=? WHERE id=?',(item['qty'],now(),item['book_id']))
            c.execute('UPDATE shop_orders SET status=? WHERE order_id=? AND shop_id=?',(status,oid,sid))
            c.execute('INSERT INTO audit_events(actor_id,action,reference,note,created) VALUES(?,?,?,?,?)',
                      (self.user_id,'shop_order_status',str(oid)+':'+str(sid),old+' -> '+status,now()))
        return self.redirect('/seller?shop='+str(sid))
    def admin_shop(self,d):
        if not self.require(('admin',)):return
        name=d.get('name','').strip()[:150];sl=d.get('slug','').strip().lower();owner=int(d.get('owner_id','0'))
        if len(name)<2 or not re.fullmatch(r'[a-z0-9-]{3,40}',sl):raise ValueError('نام و شناسه فروشگاه معتبر نیست.')
        with self.conn() as c:
            if not c.execute('SELECT id FROM users WHERE id=?',(owner,)).fetchone():raise ValueError('کاربر انتخابی پیدا نشد.')
            c.execute('INSERT INTO shops(name,slug,owner_id,description) VALUES(?,?,?,?)',(name,sl,owner,d.get('description','')[:800]))
            c.execute("UPDATE users SET role='seller' WHERE id=? AND role='customer'",(owner,))
        return self.redirect('/admin')
    def admin_user(self,d):
        if not self.require(('admin',)):return
        uid=int(d.get('user_id','0'));role=d.get('role','customer')
        if role not in ('seller','customer'):raise ValueError('نقش غیرمجاز.')
        if uid==self.user_id:raise ValueError('نقش مدیر فعلی قابل تغییر نیست.')
        with self.conn() as c:c.execute("UPDATE users SET role=? WHERE id=? AND role!='admin'",(role,uid))
        return self.redirect('/admin')
    def admin_payment(self,d):
        if not self.require(('admin',)):return
        oid=int(d.get('order_id','0'));proof=d.get('proof','').strip()
        if not 4<=len(proof)<=150:raise ValueError('شماره پیگیری مستند پرداخت باید بین ۴ تا ۱۵۰ نویسه باشد.')
        # In absence of a gateway, evidence remains an explicit human verification.
        with self.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            order=c.execute('SELECT payment_method,payment_status FROM orders WHERE id=?',(oid,)).fetchone()
            if not order:raise ValueError('سفارش وجود ندارد.')
            if order['payment_method']!='manual' or order['payment_status']!='unpaid':
                raise ValueError('فقط پرداخت هماهنگی‌شده و تأییدنشده قابل ثبت است.')
            if c.execute("SELECT 1 FROM shop_orders WHERE order_id=? AND status='cancelled'",(oid,)).fetchone():
                raise ValueError('سفارش لغوشده قابل تأیید پرداخت نیست.')
            if c.execute("SELECT 1 FROM audit_events WHERE action='payment_marked_paid' AND note=?",(proof,)).fetchone():
                raise ValueError('این شماره پیگیری قبلاً برای سفارش دیگری ثبت شده است.')
            c.execute("UPDATE orders SET payment_status='paid' WHERE id=? AND payment_status='unpaid'",(oid,))
            c.execute('INSERT INTO audit_events(actor_id,action,reference,note,created) VALUES(?,?,?,?,?)',
                      (self.user_id,'payment_marked_paid',str(oid),proof,now()))
        return self.redirect('/admin')
    def admin_review(self,d):
        if not self.require(('admin',)):return
        with self.conn() as c:c.execute('UPDATE reviews SET approved=1 WHERE id=?',(int(d.get('review_id','0')),))
        return self.redirect('/admin')
    def admin_return(self,d):
        if not self.require(('admin',)):return
        st=d.get('status','')
        if st not in ('requested','approved','rejected','completed'):raise ValueError('وضعیت نامعتبر است.')
        with self.conn() as c:c.execute('UPDATE returns SET status=? WHERE id=?',(st,int(d.get('return_id','0'))))
        return self.redirect('/admin')
    def export_orders(self):
        if not self.require(('admin',)):return
        with self.conn() as c:rows=c.execute('SELECT * FROM orders ORDER BY id DESC').fetchall()
        buf=io.StringIO();w=csv.writer(buf);w.writerow([x for x in rows[0].keys()] if rows else ['id','code','total','payment_status'])
        def safe_cell(value):
            if isinstance(value,str) and value.lstrip().startswith(('=','+','-','@','\t','\r')):
                return "'"+value
            return value
        for x in rows:w.writerow([safe_cell(v) for v in x])
        return self.binary(('\ufeff'+buf.getvalue()).encode('utf-8'),'text/csv; charset=utf-8','varaq-orders.csv')
    def import_upload(self,d,files):
        if not self.require(('admin',)):return
        if 'catalog' not in files:raise ValueError('فایل انتخاب نشده است.')
        name,raw=files['catalog'];sid=int(d.get('shop_id','0'))
        if len(raw)>20*1024*1024:raise ValueError('حجم داده بیش از حد مجاز است.')
        content=raw.decode('utf-8-sig')
        if name.lower().endswith('.csv'):data=list(csv.DictReader(io.StringIO(content)))
        elif name.lower().endswith('.json'):
            parsed=json.loads(content);data=parsed if isinstance(parsed,list) else parsed.get('books',[])
        else:raise ValueError('فقط CSV یا JSON پذیرفته می‌شود.')
        if len(data)>50_000:raise ValueError('حداکثر ۵۰ هزار ردیف در هر بار.')
        n=import_books(data,sid)
        return self.render(f'<div class="panel"><h1>{n} کتاب وارد شد</h1><p>موارد تکراری با شابک/عنوان و فروشگاه رد شدند.</p>{btn("پنل مدیریت","/admin")}</div>')

def import_books(data,sid):
    required=('title',)
    n=0
    with db() as c:
        if not c.execute('SELECT 1 FROM shops WHERE id=?',(sid,)).fetchone():raise ValueError('فروشگاه وجود ندارد.')
        for x in data:
            if not isinstance(x,dict):continue
            title=str(x.get('title','')).strip()[:240]
            if len(title)<2:continue
            isbn=str(x.get('isbn','')).strip()[:30]
            if isbn:
                if c.execute('SELECT 1 FROM books WHERE shop_id=? AND isbn=?',(sid,isbn)).fetchone():continue
            elif c.execute('SELECT 1 FROM books WHERE shop_id=? AND title=?',(sid,title)).fetchone():continue
            kind=str(x.get('kind','physical')).lower()
            if kind not in ('physical','pdf','both'):kind='physical'
            # Imported PDFs are not offered without uploaded book files AND attested rights.
            ebook=str(x.get('ebook',''))
            rights=1 if x.get('rights_ok') in (1,'1',True) else 0
            if kind in ('pdf','both') and (not re.fullmatch(r'[a-zA-Z0-9_-]+\.pdf',ebook) or not (EBOOKS/ebook).is_file() or not rights):kind='physical';ebook='';rights=0
            cov=str(x.get('cover',''))
            if not re.fullmatch(r'[a-zA-Z0-9_\-.]+',cov) or not (COVERS/cov).is_file():cov=''
            try:price=max(0,int(float(x.get('price') or 0)));stock=max(0,int(float(x.get('stock') or 0)))
            except:price=stock=0
            c.execute('INSERT INTO books(shop_id,title,author,publisher,isbn,year,category,description,price,stock,kind,cover,ebook,rights_ok,slug,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(sid,title,str(x.get('author',''))[:180],str(x.get('publisher',''))[:180],isbn,str(x.get('year',''))[:15],str(x.get('category','عمومی'))[:75],str(x.get('description',''))[:9000],price,stock,kind,cov,ebook,rights,slug(title),'active',now(),now()))
            n+=1
    return n

def main():
    ap=argparse.ArgumentParser(description='VARAQ retail feature core')
    ap.add_argument('--setup-admin',nargs=2,metavar=('USERNAME','PASSWORD'))
    ap.add_argument('--serve',action='store_true')
    ap.add_argument('--host',default=HOST)
    ap.add_argument('--port',type=int,default=PORT)
    ap.add_argument('--import-csv')
    ap.add_argument('--shop-id',type=int,default=1)
    args=ap.parse_args();init()
    if args.setup_admin:
        setup_admin(*args.setup_admin);print('Admin account created.');return
    if args.import_csv:
        with open(args.import_csv,encoding='utf-8-sig',newline='') as f:
            data=list(csv.DictReader(f)) if args.import_csv.lower().endswith('.csv') else json.load(f)
        print('Imported:',import_books(data,args.shop_id));return
    if not args.serve:ap.print_help();return
    if not BRIDGE_ENABLED and not db().execute("SELECT 1 FROM users WHERE role='admin' LIMIT 1").fetchone():
        print('ERROR: Create an admin via --setup-admin USERNAME PASSWORD first.');return
    server=ThreadingHTTPServer((args.host,args.port),Site)
    tokenfile=DATA/'stop.token'
    tokenfile.write_text(secrets.token_hex(32))
    try:os.chmod(tokenfile,0o600)
    except OSError:pass
    print(f'VARAQ live at http://{args.host}:{args.port} | CTRL+C to stop')
    try:server.serve_forever(poll_interval=.3)
    except KeyboardInterrupt:pass
    finally:
        server.server_close()
        tokenfile.unlink(missing_ok=True)

if __name__=='__main__':main()

