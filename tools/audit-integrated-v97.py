#!/usr/bin/env python3
"""Read-only comparison between Node's historic catalogue and retail's live ledger.
Does NOT migrate, reconcile, approve sellers or take a payment. Python stdlib only.
"""
import argparse,csv,datetime,io,json,sqlite3,sys
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent

def connect_ro(path):
    path=Path(path).resolve(strict=True)
    c=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=3)
    c.row_factory=sqlite3.Row
    integrity=c.execute('PRAGMA integrity_check').fetchone()[0]
    if integrity!='ok':
        c.close()
        raise RuntimeError(f'Database integrity check failed for {path.name}: {integrity}')
    return c

def table_present(c,name):
    return bool(c.execute('SELECT 1 FROM sqlite_master WHERE type=? AND name=?',('table',name)).fetchone())

def count(c,sql):return int(c.execute(sql).fetchone()[0])

def normalize(s):return ' '.join(str(s or '').replace('ي','ی').replace('ك','ک').split()).casefold()

def calculate(node,retail):
    for c,names in ((node,['books','stores','stock_items','demo_orders']),
                    (retail,['books','shops','orders','order_items'])):
        for name in names:
            if not table_present(c,name):raise RuntimeError('Required table missing: '+name)
    nbooks={int(r['id']):r for r in node.execute('SELECT id,title,author FROM books')}
    rbooks={int(r['id']):r for r in retail.execute('SELECT id,title,author,shop_id,price,stock,status,kind FROM books')}
    nid=set(nbooks);rid=set(rbooks)
    missing=sorted(nid-rid);extra=sorted(rid-nid)
    conflicts=[]
    for key in sorted(nid&rid):
        a,b=nbooks[key],rbooks[key]
        if normalize(a['title'])!=normalize(b['title']):
            conflicts.append({'book_id':key,'legacy_title':a['title'],'retail_title':b['title'],'issue':'title_mismatch'})
    # Legacy inventory is NOT a source for retail stock; report rather than change it.
    old_inventory=node.execute('''SELECT b.id book_id,b.title,COUNT(*) sku_count,
          SUM(CASE WHEN si.active=1 AND si.quantity>0 THEN si.quantity ELSE 0 END) units
          FROM stock_items si JOIN books b ON b.id=si.book_id GROUP BY b.id''').fetchall()
    old_qty={int(r['book_id']):int(r['units'] or 0) for r in old_inventory}
    retail_by_book={k:int(v['stock']) for k,v in rbooks.items()}
    stock_differences=[]
    for bid in sorted(old_qty):
        old=old_qty[bid];new=retail_by_book.get(bid)
        if new is None:continue
        if old!=new:
            stock_differences.append({'book_id':bid,'title':nbooks[bid]['title'],
                       'legacy_stock':old,'retail_stock':new,'issue':'separate_inventory_ledgers'})
    shops=retail.execute('SELECT id,name,bridge_store_id FROM shops ORDER BY id').fetchall()
    legacy_store_ids={int(x['id']) for x in node.execute('SELECT id FROM stores')}
    unmapped=[{'retail_shop_id':int(x['id']),'name':x['name']} for x in shops
              if x['bridge_store_id'] is None or int(x['bridge_store_id']) not in legacy_store_ids]
    summary={'node_books':len(nbooks),'retail_books':len(rbooks),
      'missing_books_in_retail':len(missing),'extra_books_in_retail':len(extra),
      'different_book_titles':len(conflicts),'old_node_demo_orders':count(node,'SELECT COUNT(*) FROM demo_orders'),
      'retail_orders':count(retail,'SELECT COUNT(*) FROM orders'),
      'retail_order_lines':count(retail,'SELECT COUNT(*) FROM order_items'),
      'legacy_sku_rows':count(node,'SELECT COUNT(*) FROM stock_items'),
      'inventory_disagreements':len(stock_differences),'unmapped_retail_shops':len(unmapped),
      'retail_books_without_stock':count(retail,'SELECT COUNT(*) FROM books WHERE stock<=0'),
      'retail_books_without_price':count(retail,'SELECT COUNT(*) FROM books WHERE price<=0')}
    return {'version':'9.7','generated_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
      'purpose':'read-only diagnostic; not a migration, order settlement or inventory synchronization',
      'source_of_truth_for_new_checkout':'market/data/varaq.sqlite3',
      'legacy_demo_orders_are_not_real_sales':True,
      'summary':summary,
      'missing_book_ids':missing,'retail_only_book_ids':extra,
      'title_conflicts':conflicts,'stock_disagreements':stock_differences,
      'unmapped_retail_shops':unmapped}

def run(node_db,retail_db,output_dir):
    with connect_ro(node_db) as n,connect_ro(retail_db) as r:
        result=calculate(n,r)
    output_dir=Path(output_dir)
    output_dir.mkdir(parents=True,exist_ok=True)
    target=output_dir/'audit_v97.json'
    target.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    csvpath=output_dir/'inventory_conflicts_v97.csv'
    with csvpath.open('w',encoding='utf-8-sig',newline='') as f:
        w=csv.DictWriter(f,fieldnames=['book_id','title','legacy_stock','retail_stock','issue']);w.writeheader();w.writerows(result['stock_disagreements'])
    return result,target,csvpath

if __name__=='__main__':
    pa=argparse.ArgumentParser(description='VARAQ read-only integration audit')
    pa.add_argument('--node-db',default=str(ROOT/'storage'/'varaq.sqlite'))
    pa.add_argument('--retail-db',default=str(ROOT/'market'/'data'/'varaq.sqlite3'))
    pa.add_argument('--out-dir',default=str(ROOT/'market'/'data'/'reports'))
    args=pa.parse_args()
    try:
        obj,js,cs=run(args.node_db,args.retail_db,args.out_dir)
        print(json.dumps(obj['summary'],ensure_ascii=False,indent=2))
        print('Reports:',js,cs)
    except (RuntimeError,sqlite3.Error,OSError) as exc:
        print('Audit not completed:',exc,file=sys.stderr)
        sys.exit(2)
