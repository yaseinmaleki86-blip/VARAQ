"""VARAQ v9.8 isolated identity mapping tests (stdlib only)."""
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('link98',ROOT/'market'/'CATALOG_LINK_V98.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)

class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.n=self.root/'node.sqlite';self.r=self.root/'retail.sqlite'
        with sqlite3.connect(self.n) as c:
            c.execute('CREATE TABLE books(id INTEGER PRIMARY KEY,title TEXT,author TEXT,isbn TEXT)')
        with sqlite3.connect(self.r) as c:
            c.execute('PRAGMA foreign_keys=ON')
            c.execute('CREATE TABLE books(id INTEGER PRIMARY KEY,title TEXT,author TEXT,isbn TEXT,price INTEGER,stock INTEGER)')
        self.out=self.root/'reports';self.bk=self.root/'backups'
    def add_node(self,id,title,author='مؤلف',isbn=''):
        with sqlite3.connect(self.n) as c:c.execute('INSERT INTO books VALUES(?,?,?,?)',(id,title,author,isbn))
    def add_retail(self,id,title,author='مؤلف',isbn='',price=200,stock=7):
        with sqlite3.connect(self.r) as c:c.execute('INSERT INTO books VALUES(?,?,?,?,?,?)',(id,title,author,isbn,price,stock))
    def run_link(self,apply=False):return mod.run(self.n,self.r,self.out,apply,self.bk)
    def test_exact_identity_and_backup(self):
        self.add_node(101,'ملت عشق','الیف شافاک');self.add_retail(999,'ملت عشق','الیف شافاک')
        before=self.r.read_bytes()
        preview=self.run_link();self.assertEqual(preview['summary']['new_unambiguous_links'],1)
        self.assertEqual(self.r.read_bytes(),before)
        result=self.run_link(True);self.assertEqual(result['applied'],1)
        with sqlite3.connect(self.r) as c:
            self.assertEqual(c.execute('SELECT retail_book_id FROM catalog_identity_links WHERE node_book_id=101').fetchone()[0],999)
            self.assertEqual(c.execute('SELECT price,stock FROM books').fetchone(),(200,7))
        self.assertTrue(list(self.bk.glob('*.sqlite3')))
    def test_idempotence_no_extra_backup(self):
        self.add_node(1,'کتاب الف');self.add_retail(50,'کتاب الف')
        self.run_link(True);n=len(list(self.bk.glob('*.sqlite3')))
        again=self.run_link(True)
        self.assertEqual(again['applied'],0);self.assertEqual(n,len(list(self.bk.glob('*.sqlite3'))))
    def test_same_title_different_author_are_distinct(self):
        self.add_node(1,'کتاب الف','نویسنده اول');self.add_node(2,'کتاب الف','نویسنده دوم')
        self.add_retail(20,'کتاب الف','نویسنده دوم');self.add_retail(30,'کتاب الف','نویسنده اول')
        r=self.run_link(True);self.assertEqual(r['applied'],2)
        with sqlite3.connect(self.r) as c:
            self.assertEqual(c.execute('SELECT retail_book_id FROM catalog_identity_links WHERE node_book_id=1').fetchone()[0],30)
            self.assertEqual(c.execute('SELECT retail_book_id FROM catalog_identity_links WHERE node_book_id=2').fetchone()[0],20)
    def test_ambiguous_duplicate_not_linked(self):
        self.add_node(1,'The Stranger','Author');self.add_retail(10,'The Stranger','Author');self.add_retail(11,'The Stranger','Author')
        r=self.run_link(True);self.assertEqual(r['applied'],0)
        self.assertEqual(r['summary']['needs_manual_review'],1)
    def test_isbn_conflict_is_not_mapped(self):
        self.add_node(1,'کتاب الف','نویسنده','9780000000011');self.add_retail(3,'کتاب الف','نویسنده','9780000000022')
        r=self.run_link(True);self.assertEqual(r['applied'],0)
        self.assertEqual(r['manual_review'][0]['issue'],'isbn_conflict')
    def test_moved_title_reports_drift_but_preserves_link(self):
        self.add_node(1,'کتاب الف');self.add_retail(5,'کتاب الف')
        self.run_link(True)
        with sqlite3.connect(self.r) as c:c.execute('UPDATE books SET title=? WHERE id=5',('کتاب تازه',))
        r=self.run_link(True);self.assertEqual(r['applied'],0)
        self.assertEqual(r['summary']['existing_links_needing_review'],1)
        with sqlite3.connect(self.r) as c:self.assertEqual(c.execute('SELECT count(*) FROM catalog_identity_links').fetchone()[0],1)
    def test_unicode_normalization(self):
        self.add_node(1,'زندگيِ من','  كاتب ');self.add_retail(17,'زندگیِ من','کاتب')
        r=self.run_link(True);self.assertEqual(r['applied'],1)
    def test_real_catalogue_1000(self):
        b=json.loads((ROOT/'data'/'books.json').read_text(encoding='utf-8'))
        with sqlite3.connect(self.n) as c:
            c.executemany('INSERT INTO books VALUES(?,?,?,?)',[(i['id'],i['title'],i['author'],i.get('isbn','')) for i in b])
        source=sqlite3.connect(ROOT/'market'/'data'/'varaq.sqlite3')
        try:
            with sqlite3.connect(self.r) as dest:
                # Recreate only the retail bibliographic test fixture with original books data.
                rows=source.execute('SELECT id,title,author,isbn FROM books').fetchall()
                dest.executemany('INSERT INTO books (id,title,author,isbn,price,stock) VALUES(?,?,?,?,0,0)',rows)
        finally:source.close()
        result=self.run_link(True)
        self.assertEqual(result['applied'],1000)
        self.assertEqual(result['summary']['needs_manual_review'],0)
        with sqlite3.connect(self.r) as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM catalog_identity_links').fetchone()[0],1000)

if __name__=='__main__':unittest.main(verbosity=2)
