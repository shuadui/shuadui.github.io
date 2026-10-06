#!/usr/bin/env python3
"""由 plans 產生 lookup.by_store，格式化後寫回檔案並印出核對數字。
用法：python3 build_lookup.py richart_plans.json
"""
import json, re, sys, unicodedata

path = sys.argv[1]
with open(path, encoding='utf-8') as f:
    data = json.load(f)

def norm(s):
    # 去掉括號註記：「新光三越(含skm pay)」→「新光三越」
    return re.sub(r'\s*[\(（][^\)）]*[\)）]', '', s).strip()

order = {p['name']: i for i, p in enumerate(data['plans'])}
by_store = {}
for p in data['plans']:
    for ch in p['channels']:
        for s in ch.get('stores', []):
            by_store.setdefault(norm(s), []).append(
                {'plan': p['name'], 'channel': ch['name'], 'rate_pct': ch['rate_pct']})
for v in by_store.values():
    v.sort(key=lambda e: (-e['rate_pct'], order[e['plan']]))
data['lookup']['by_store'] = by_store

def dw(s):  # 顯示寬度：全形字算 2
    return sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in s)

W = 100
def is_scalar(v): return not isinstance(v, (dict, list))
def dump(o, lv=0):
    ind, ind1 = '  ' * lv, '  ' * (lv + 1)
    one = json.dumps(o, ensure_ascii=False)
    if isinstance(o, list):
        if not o: return '[]'
        if all(is_scalar(x) for x in o):
            if dw(ind) + dw(one) <= W: return one
            lines, cur = [], ''
            for pt in (json.dumps(x, ensure_ascii=False) for x in o):
                cand = (cur + ', ' + pt) if cur else pt
                if cur and dw(ind1) + dw(cand) + 1 > W:
                    lines.append(cur); cur = pt
                else:
                    cur = cand
            lines.append(cur)
            return '[\n' + ',\n'.join(ind1 + l for l in lines) + '\n' + ind + ']'
        if all(isinstance(x, dict) and all(is_scalar(v) for v in x.values()) for x in o) and dw(ind) + dw(one) <= W:
            return one
        return '[\n' + ',\n'.join(ind1 + dump(x, lv + 1) for x in o) + '\n' + ind + ']'
    if isinstance(o, dict):
        if not o: return '{}'
        if all(is_scalar(v) for v in o.values()) and dw(ind) + dw(one) <= W:
            return one
        return '{\n' + ',\n'.join(ind1 + json.dumps(k, ensure_ascii=False) + ': ' + dump(v, lv + 1)
                                  for k, v in o.items()) + '\n' + ind + '}'
    return one

out = dump(data) + '\n'
assert json.loads(out) == data
with open(path, 'w', encoding='utf-8', newline='\n') as f:  # 固定 LF：Windows 文字模式預設會寫成 CRLF
    f.write(out)

# 核對輸出（應與計畫 2.4 一致）
total = 0
for p in data['plans']:
    counts = [(ch['name'], ch['rate_pct'], len(ch.get('stores', []))) for ch in p['channels']]
    n = sum(c[2] for c in counts); total += n
    print(p['name'], p['max_rate_pct'], p['period']['start'], '~', p['period']['end'], '| stores:', n)
    for c in counts: print('   ', c)
print('total store entries:', total, '| unique stores:', len(by_store))
print('stores in multiple plans:')
for k, v in by_store.items():
    if len(v) > 1:
        print('   ', k, [(e['plan'], e['rate_pct']) for e in v])
