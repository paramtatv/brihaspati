# Headless Chromium test of docs/: run each chosen cell in the page, assert browser == native for every field,
# save screenshots. usage: python3 test/site.py [outdir]   (needs: pip install playwright; system Chrome)
import sys, os, threading, http.server, functools, json
from playwright.sync_api import sync_playwright
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs')
out = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(out, exist_ok=True)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
h = functools.partial(Q, directory=root)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = 'http://127.0.0.1:%d/index.html' % srv.server_address[1]
bad = 0
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', args=['--js-flags=--max-old-space-size=4096'])
    pg = b.new_page(viewport={'width': 1200, 'height': 1000})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(url)
    pg.wait_for_function('!document.getElementById("run").disabled', timeout=60000)
    pg.screenshot(path=os.path.join(out, 'site-initial.png'), full_page=True)
    for cell in ['print_x.t1', 'loop_sum.t1', 'checked_add_overflow_refusal.t1', 'entry_not_fixed_refused.t1', 'heap_over_64mib.t1']:
        pg.select_option('#cell', cell)
        pg.evaluate('window.__demo = null')
        pg.click('#run')
        pg.wait_for_function('window.__demo', timeout=300000)
        r = pg.evaluate('window.__demo')
        ok = r.get('all') is True
        print(('ok  ' if ok else 'FAIL'), cell, r.get('failed', ''), pg.inner_text('#status'))
        if not ok: bad += 1
        if cell == 'print_x.t1': pg.screenshot(path=os.path.join(out, 'site-print_x.png'), full_page=True)
    pg.select_option('#lang', 'en'); pg.screenshot(path=os.path.join(out, 'site-en.png'), full_page=True)
    if errs: print('page errors:', errs); bad += 1
    b.close()
sys.exit(1 if bad else 0)
