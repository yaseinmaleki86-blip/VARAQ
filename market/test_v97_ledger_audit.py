#!/usr/bin/env python3
"""Run standalone: python market/test_v97_ledger_audit.py"""
import importlib.util,sqlite3,tempfile,json
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('integration_audit', ROOT/'tools'/'audit-integrated-v97.py')
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
with tempfile.TemporaryDirectory(prefix='varaq97-ledger-') as t:
    p=Path(t); n=p/'node.sqlite';r=p/'retail.sqlite';out=p/'reports'
    with sqlite3.connect(n) as c:
        c.executescript('''CREATE TABLE books(id INTEGER PRIMARY KEY,title TEXT,author TEXT);
          CREATE TABLE stores(id INTEGER PRIMARY KEY);
          CREATE TABLE stock_items(id INTEGER PRIMARY KEY,book_id INTEGER,active INTEGER,quantity INTEGER);
          CREATE TABLE demo_orders(id INTEGER PRIMARY KEY);
          INSERT INTO books VALUES(1,'کتاب یک',''),(2,'کتاب دو','');
          INSERT INTO stores VALUES(1);INSERT INTO stock_items VALUES(1,1,1,8);
          INSERT INTO demo_orders VALUES(1);''')
    with sqlite3.connect(r) as c:
        c.executescript('''CREATE TABLE books(id INTEGER PRIMARY KEY,title TEXT,author TEXT,shop_id INTEGER,price INTEGER,stock INTEGER,status TEXT,kind TEXT);
          CREATE TABLE shops(id INTEGER PRIMARY KEY,name TEXT,bridge_store_id INTEGER);
          CREATE TABLE orders(id INTEGER PRIMARY KEY);CREATE TABLE order_items(id INTEGER PRIMARY KEY);
          INSERT INTO books VALUES(1,'کتاب یک','',1,25000,3,'active','physical');
          INSERT INTO books VALUES(2,'کتاب تغییر نام','',1,0,0,'active','physical');
          INSERT INTO shops VALUES(1,'فروشگاه یک',NULL);INSERT INTO orders VALUES(1);''')
    old=n.read_bytes();new=r.read_bytes()
    report,js,cs=a.run(n,r,out)
    s=report['summary']
    assert (s['node_books'],s['retail_books'],s['retail_orders'],s['old_node_demo_orders'])==(2,2,1,1)
    assert s['different_book_titles']==1 and s['inventory_disagreements']==1 and s['unmapped_retail_shops']==1
    assert report['stock_disagreements'][0]['retail_stock']==3
    assert js.exists() and cs.exists()
    assert old==n.read_bytes() and new==r.read_bytes(), 'Audit changed source DB!'
    try:a.run(p/'missing.sqlite',r,out)
    except FileNotFoundError:pass
    else:raise AssertionError('Missing source must not create empty ledger or a success report')
    print('PASS v9.7: readonly, mismatched titles, stock conflicts, unmapped shops, order counts, missing files')
