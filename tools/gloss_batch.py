# -*- coding: utf-8 -*-
"""_lex.json 의 빈 ko 필드를 Worker의 /gloss 경로로 일괄 번역한다.

API 키는 Cloudflare 에만 있고 이 스크립트에는 없다. 관리자 열쇠만 환경변수로
읽어 Worker 에 넘긴다.

    setx MIQRA_ADMIN "발급한 값"        (한 번만. 새 터미널에서 유효)
    python tools/gloss_batch.py          전체
    python tools/gloss_batch.py 5        5묶음만 (100개씩이므로 500개)

결과는 tools/koglo_auto/NNNN.json 에 묶음마다 바로 저장한다. 다시 실행하면
이미 있는 묶음은 건너뛰므로, 중간에 끊겨도 앞서 지불한 몫을 다시 물지 않는다.

빈도가 높은 낱말부터 처리한다. 중간에 멈추더라도 커버리지가 가장 많이 오른
상태로 남는다.
"""
import json, os, re, sys, io, time, collections, urllib.request, urllib.error

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = 'https://miqra-sum.chlqkrtk12.workers.dev/gloss'
ORIGIN = 'https://emmaustransbible.co.kr'
OUT = os.path.join(ROOT, 'tools', 'koglo_auto')
SIZE = 100
RETRY = 3

def counts():
    occ = collections.Counter()
    books = os.path.join(ROOT, 'books')
    for fn in os.listdir(books):
        if not fn.endswith('.json') or fn.startswith('_'):
            continue
        d = json.load(open(os.path.join(books, fn), encoding='utf-8'))
        for ch in (d.get('heb') or {}).values():
            for words in ch.values():
                for w in words:
                    if w.get('s'):
                        occ[w['s']] += 1
    return occ

def call(items, admin):
    payload = json.dumps({'admin': admin, 'items': items}).encode('utf-8')
    # User-Agent 를 붙이지 않으면 Cloudflare 앞단이 파이썬 기본값을 봇으로 보고
    # 워커에 닿기도 전에 403(error code 1010)으로 끊는다.
    req = urllib.request.Request(API, data=payload, method='POST', headers={
        'Content-Type': 'application/json', 'Origin': ORIGIN,
        'User-Agent': 'miqra-gloss-tool/1.0 (+https://emmaustransbible.co.kr)'})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode('utf-8'))

def main():
    admin = os.environ.get('MIQRA_ADMIN', '').strip()
    if not admin:
        print('환경변수 MIQRA_ADMIN 이 비어 있습니다.')
        print('  Cloudflare 에 넣어 둔 ADMIN_KEY 와 같은 값을 넣어야 합니다.')
        print('  PowerShell:  $env:MIQRA_ADMIN = "값"')
        return 1
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 0

    lex = json.load(open(os.path.join(ROOT, 'books', '_lex.json'), encoding='utf-8'))
    occ = counts()
    todo = [s for s, v in lex.items()
            if not (v or {}).get('ko') and not re.match(r'^[A-Z]', str((v or {}).get('ge') or ''))]
    todo.sort(key=lambda s: -occ.get(s, 0))
    print('채울 일반 낱말 %d개 · 묶음 %d개 (묶음당 %d개)'
          % (len(todo), (len(todo) + SIZE - 1) // SIZE, SIZE))

    os.makedirs(OUT, exist_ok=True)
    done = ok = skip = fail = 0
    for i in range(0, len(todo), SIZE):
        n = i // SIZE
        path = os.path.join(OUT, '%04d.json' % n)
        if os.path.exists(path):
            skip += 1
            continue
        if limit and done >= limit:
            break

        chunk = todo[i:i + SIZE]
        items = [{'s': s, 't': lex[s].get('t') or '', 'ge': lex[s].get('ge') or '',
                  'd': (lex[s].get('d') or lex[s].get('sd') or '')} for s in chunk]

        for attempt in range(1, RETRY + 1):
            try:
                res = call(items, admin)
                g = res.get('glosses') or {}
                json.dump(g, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
                print('  %04d  요청 %3d개 → 받음 %3d개  (%d~%d회)'
                      % (n, res.get('asked', 0), len(g),
                         occ.get(chunk[-1], 0), occ.get(chunk[0], 0)))
                ok += len(g)
                break
            except urllib.error.HTTPError as e:
                msg = e.read().decode('utf-8', 'replace')[:200]
                if e.code in (403, 409):          # 열쇠 문제나 영구 오류는 재시도해도 같다
                    print('  %04d  중단: %s %s' % (n, e.code, msg))
                    return 1
                print('  %04d  %d회차 실패 %s %s' % (n, attempt, e.code, msg))
            except Exception as e:
                print('  %04d  %d회차 실패 %s' % (n, attempt, e))
            time.sleep(2 * attempt)
        else:
            fail += 1
        done += 1

    print('\n새로 만든 뜻 %d개 · 건너뛴 묶음 %d개 · 실패한 묶음 %d개' % (ok, skip, fail))
    print('확인 후 tools/koglo/ 로 옮기고 python tools/merge_koglo.py 를 돌리세요.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
