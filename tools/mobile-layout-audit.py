#!/usr/bin/env python3
"""Optional Chromium *offline HTML/CSS* layout audit for VARAQ 8.2.

Requires Python 3 + `playwright` and a compatible Chromium. The website itself
uses only Node; it does NOT require Python or Playwright to start.

We fetch each page with urllib and inject the shipped CSS before passing it to
Chromium via set_content. This works where Chromium is prohibited from opening
localhost URLs directly. It does not validate real network, JS, or mobile OS.
"""
import argparse
import json
import os
import re
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROUTES = ('/', '/books', '/book/book-001', '/book/book-001/read', '/pdf-books')
WIDTHS = (320, 390, 430, 768, 1280)


def available_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def get(base, route):
    with urllib.request.urlopen(base + route, timeout=8) as res:
        return res.read().decode('utf-8')


def run():
    from playwright.sync_api import sync_playwright

    port = available_port()
    base = f'http://127.0.0.1:{port}'
    stylesheet = (ROOT / 'public/style.css').read_text(encoding='utf-8')
    with tempfile.TemporaryDirectory(prefix='varaq78-layout-') as data_dir:
        env = {**os.environ, 'PORT':str(port), 'HOST':'127.0.0.1',
               'PUBLIC_URL':base, 'DATA_DIR':data_dir, 'PUBLIC_READONLY':'1'}
        proc = subprocess.Popen(['node','server.js'], cwd=ROOT, env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for i in range(100):
                try:
                    get(base, '/health')
                    break
                except Exception:
                    time.sleep(.12)
            else:
                raise RuntimeError('The private test server did not become ready')
            checks = []
            with sync_playwright() as playwright:
                browser_args=['--no-sandbox', '--disable-dev-shm-usage']
                try:
                    browser = playwright.chromium.launch(headless=True, args=browser_args)
                except Exception:
                    chromium = '/usr/bin/chromium'
                    if not Path(chromium).exists():
                        raise
                    browser = playwright.chromium.launch(executable_path=chromium,
                                                          headless=True, args=browser_args)
                try:
                    for width in WIDTHS:
                        page = browser.new_page(viewport={'width': width, 'height':820}, locale='fa-IR')
                        # The snapshot is intentionally static to measure layout and touch sizes.
                        page.route('**/*', lambda route: route.abort())
                        for route in ROUTES:
                            html = get(base, route)
                            html = re.sub(r'<link[^>]+href="https://fonts\.[^"]+"[^>]*>', '', html)
                            html = re.sub(r'<link[^>]+href="/assets/[^">]+"[^>]*>',
                                          lambda match: '<style>' + stylesheet + '</style>', html)
                            html = re.sub(r'<script[^>]+src="/assets/[^">]+"[^>]*></script>', '', html)
                            page.set_content(html, wait_until='domcontentloaded', timeout=15000)
                            measured = page.evaluate('''() => {
                              const doc=document.documentElement;
                              const grid=document.querySelector('.book-grid');
                              const action=[...document.querySelectorAll('.book-card-v48 .v68-card-actions a')].find(e=>e.getBoundingClientRect().height>0);
                              const columns=grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : null;
                              return {viewport:innerWidth,scrollWidth:doc.scrollWidth,
                                horizontalOverflow:doc.scrollWidth>doc.clientWidth+3,
                                columns, cardActionHeight:action ? Math.round(action.getBoundingClientRect().height):null};
                            }''')
                            no_overflow=not measured['horizontalOverflow']
                            compact=route in ('/', '/books') and width<=430
                            correct_columns=(not compact or measured['columns']==1)
                            touch=(not compact or measured['cardActionHeight'] is not None
                                   and measured['cardActionHeight'] >= 43)
                            checks.append({'width':width,'route':route,**measured,
                                           'passed':no_overflow and correct_columns and touch})
                        page.close()
                finally:
                    browser.close()
            return {'version':'8.2.0','type':'offline Chromium layout only; not mobile-device or real network testing',
                    'checked':len(checks),'passed':all(x['passed'] for x in checks),'checks':checks}
        finally:
            proc.terminate()
            try: proc.wait(timeout=3)
            except subprocess.TimeoutExpired:proc.kill()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json',action='store_true')
    args=parser.parse_args()
    try:
        result=run()
    except (ImportError, FileNotFoundError) as error:
        raise SystemExit('Optional layout QA requires Python playwright and Chromium: '+str(error))
    if args.json:print(json.dumps(result,ensure_ascii=False,indent=2))
    else:
        print('VARAQ 8.2 offline Chromium layout: '+str(sum(x['passed'] for x in result['checks']))+'/'+str(result['checked'])+' checks passed')
        for row in result['checks']:
            print(('PASS ' if row['passed'] else 'FAIL ')+f"{row['width']}px {row['route']} width={row['scrollWidth']} cols={row['columns']} action={row['cardActionHeight']}")
    if not result['passed']:raise SystemExit(1)
