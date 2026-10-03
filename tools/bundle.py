#!/usr/bin/env python3
"""
Собирает P2PDesk в один самодостаточный index.html:
  - 4 CSS-файла → <style>
  - граф ES-модулей → один <script> с крошечным рантайм-реестром
  - PNG монет → data: URI
Внешними остаются только Google Fonts и Telegram WebApp SDK.
"""
import re, os, json, base64, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', 'index.html')

CSS = ['styles/tokens.css', 'styles/base.css', 'styles/components.css', 'styles/screens.css']
ENTRY = 'src/main.js'

# ---------- изображения → data URI ----------
# для встраивания берём уменьшенную копию, если она меньше оригинала
SHRUNK = os.path.join(ROOT, 'assets/coins/min')   # предсжатые копии для встраивания

def best_bytes(name):
    orig = os.path.join(ROOT, 'assets/coins', name)
    cand = [orig]
    small = os.path.join(SHRUNK, name)
    if os.path.exists(small):
        cand.append(small)
    pick = min(cand, key=os.path.getsize)
    with open(pick, 'rb') as f:
        return f.read(), pick

IMAGES = {}
saved = 0
for name in sorted(os.listdir(os.path.join(ROOT, 'assets/coins'))):
    if not name.endswith('.png'):
        continue
    raw, pick = best_bytes(name)
    saved += os.path.getsize(os.path.join(ROOT, 'assets/coins', name)) - len(raw)
    IMAGES['./assets/coins/' + name] = 'data:image/png;base64,' + base64.b64encode(raw).decode()

def inline_images(src):
    for ref, uri in IMAGES.items():
        src = src.replace("'" + ref + "'", "'" + uri + "'")
        src = src.replace('"' + ref + '"', '"' + uri + '"')
    return src

# ---------- обход графа модулей ----------
IMPORT_RE = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?\s*$", re.M)

def resolve(spec, from_mod):
    base = os.path.dirname(os.path.join(ROOT, from_mod))
    return os.path.relpath(os.path.normpath(os.path.join(base, spec)), ROOT)

modules = {}
order = []

def load(mod):
    if mod in modules:
        return
    modules[mod] = None                      # метка «в процессе» — защита от циклов
    with open(os.path.join(ROOT, mod), encoding='utf-8') as f:
        src = f.read()
    for m in IMPORT_RE.finditer(src):
        load(resolve(m.group(2), mod))
    modules[mod] = src
    order.append(mod)

load(ENTRY)

# ---------- трансформация модуля ----------
def transform(mod, src):
    exports = []

    def repl_import(m):
        names, spec = m.group(1), m.group(2)
        target = resolve(spec, mod)
        parts = []
        for raw in names.split(','):
            raw = raw.strip()
            if not raw:
                continue
            if ' as ' in raw:
                a, b = [x.strip() for x in raw.split(' as ')]
                parts.append(f'{a}: {b}')
            else:
                parts.append(raw)
        return f"const {{ {', '.join(parts)} }} = __req({json.dumps(target)});"

    src = IMPORT_RE.sub(repl_import, src)

    # export function f(...)  →  function f(...)   + регистрация
    def repl_fn(m):
        exports.append(m.group(1))
        return f'function {m.group(1)}('
    src = re.sub(r'^export\s+function\s+([A-Za-z_$][\w$]*)\s*\(', repl_fn, src, flags=re.M)

    # export const x = ...  →  const x = ...
    def repl_const(m):
        exports.append(m.group(1))
        return f'const {m.group(1)} ='
    src = re.sub(r'^export\s+const\s+([A-Za-z_$][\w$]*)\s*=', repl_const, src, flags=re.M)

    # export { a, b };
    def repl_list(m):
        for raw in m.group(1).split(','):
            raw = raw.strip()
            if raw:
                exports.append(raw)
        return ''
    src = re.sub(r'^export\s*\{([^}]*)\}\s*;?\s*$', repl_list, src, flags=re.M)

    leftover = re.findall(r'^export\s+.*$', src, flags=re.M)
    if leftover:
        raise SystemExit(f'НЕОБРАБОТАННЫЙ export в {mod}: {leftover[0]!r}')

    src = inline_images(src)

    reg = '\n'.join(f'  __x.{n} = {n};' for n in dict.fromkeys(exports))
    return (f'__m[{json.dumps(mod)}] = function (__x, __req) {{\n'
            f'{src}\n{reg}\n}};\n')

bundle = []
for mod in order:
    bundle.append(transform(mod, modules[mod]))

runtime = '''(function () {
  'use strict';
  var __m = {}, __c = {};
  function __req(id) {
    if (__c[id]) return __c[id];
    var f = __m[id];
    if (!f) throw new Error('module not found: ' + id);
    var x = __c[id] = {};
    f(x, __req);
    return x;
  }
'''

js = runtime + '\n'.join(bundle) + f'\n  __req({json.dumps(ENTRY)});\n}})();\n'

# ---------- css ----------
css = '\n'.join(f'/* ===== {p} ===== */\n' + open(os.path.join(ROOT, p), encoding='utf-8').read() for p in CSS)

# ---------- html ----------
html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
html = re.sub(r'\n?\s*<link rel="stylesheet" href="\./styles/[^"]+">', '', html)
html = html.replace('<script type="module" src="./src/main.js"></script>',
                    '<script>\n' + js + '</script>')
html = html.replace('</head>', '<style>\n' + css + '\n</style>\n</head>')
html = html.replace('<title>P2PDesk — AI P2P Terminal</title>',
                    '<title>P2PDesk — AI P2P Terminal</title>\n'
                    '<!-- Self-contained сборка: CSS, JS и иконки монет встроены в этот файл.\n'
                    '     Внешние зависимости только две: Google Fonts и Telegram WebApp SDK.\n'
                    '     Исходники: github.com/pathfys/p2p -->')

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    f.write(html)

print(f'модулей: {len(order)}')
print(f'картинки: сэкономлено {saved/1024:.0f} KB')
print(f'размер : {os.path.getsize(OUT)/1024:.0f} KB')
print(f'файл   : {OUT}')
