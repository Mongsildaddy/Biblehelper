# -*- coding: utf-8 -*-
"""tools/koglo_auto/*.json (Worker /gloss 결과)을 검수 수정과 함께
tools/koglo/a01.json 하나로 묶는다. merge_koglo.py 가 이 파일을 읽는다.

자동 번역 결과는 저장소에 넣지 않고(koglo_auto 는 gitignore), 검수 수정을
반영한 최종본만 넣는다. 그래야 어떤 값이 손으로 고친 것인지 FIX 에 남는다.
"""
import json, os, re, sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'koglo_auto')
OUT = os.path.join(ROOT, 'tools', 'koglo', 'a01.json')

# 검수에서 손으로 고친 것. 영문 뜻이 괄호로 시작하는 지명('(Mount) Halak')은
# 대문자 판정을 피해 일반 낱말로 넘어갔고, 일부는 뜻풀이가 되어 버렸다.
FIX = {
    # 괄호로 감싼 지명·고유명사 — 개역한글 표기로
    'H6190': '양피',
    'H4307': '시위청·과녁',
    'H8574': '풀무·화덕',
    'H3465': '옛·오래된',
    'H4192': '뭇랍벤(곡조)',
    'H2510': '할락 산',
    'H3726': '그발암모니',
    'H3968': '함메아 망대',
    'H4036': '마골밋사빕',
    'H7865': '시온 산',
    'H7104': '에멕그시스',
    'H5346': '아다미네겝',
    'H0791': '벧아스베아',
    'H1056': '눈물 골짜기',
    'H2041': '멸망의 성',
    # 일반 낱말 표본 검수
    'H5953a': '학대하다·희롱하다',
    'G3193': '벌집',
    'G5063': '사십 년',
    'H1325': '밧(용량)',
    'G4568': '스아(용량)',
    'G3712': '길(길이)',
    # 2회차(koglo_auto2) 검수
    'G0675': '압비오 저자',
    'G0370': '합당치 않은',
    'G0130': '피 흘림',
    'G6061': '맷돌',
}

def normalize(v):
    v = v.strip().rstrip('!.,;')
    # '헤르몬산' → '헤르몬 산': 기존 3,500개는 '그리심 산'처럼 띄어 쓴다
    v = re.sub(r'([가-힣]{2,})산$', r'\1 산', v) if re.search(r'[가-힣]{2,}산$', v) and len(v) >= 3 else v
    # '크게하다' 같은 부사+하다 붙여쓰기
    v = re.sub(r'([가-힣]+게)(하다|되다)$', r'\1 \2', v)
    return v

# '산'으로 끝나지만 산 이름이 아닌 낱말 — 띄어쓰기 규칙에서 뺀다
NOT_MOUNT = {'출산', '재산', '유산', '생산', '계산', '청산', '산산', '해산', '분산', '타산', '파산', '광산', '소산', '실산'}

def main():
    lex = json.load(open(os.path.join(ROOT, 'books', '_lex.json'), encoding='utf-8'))
    allg = {}
    tools = os.path.join(ROOT, 'tools')
    for d in sorted(x for x in os.listdir(tools) if x.startswith('koglo_auto')):
        for fn in sorted(os.listdir(os.path.join(tools, d))):
            if fn.endswith('.json'):
                allg.update(json.load(open(os.path.join(tools, d, fn), encoding='utf-8')))
    # 앞 회차에서 a01.json 으로 이미 반영한 값은 _lex.json 에 ko 가 있으므로
    # 아래 루프에서 건너뛴다. a01.json 을 다시 쓸 때 그 값을 잃지 않게 합쳐 둔다.
    prev = json.load(open(OUT, encoding='utf-8')) if os.path.exists(OUT) else {}

    out, changed = dict(prev), []
    for k, v in allg.items():
        if (lex.get(k) or {}).get('ko'):
            continue                       # 이미 손으로 채운 값은 건드리지 않는다
        if k in FIX:
            nv = FIX[k]
        elif v.rstrip('!.,;') in NOT_MOUNT or not re.search(r'산$', v):
            nv = normalize(v) if not v.endswith('산') else v.rstrip('!.,;')
        else:
            ge = str(lex[k].get('ge') or '')
            nv = normalize(v) if re.search(r'Mount|Mt', ge) else v
        if nv != v:
            changed.append((k, v, nv))
        out[k] = nv

    json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1, sort_keys=True)
    print('a01.json %d개 (이번에 새로 %d개) · 수정 %d개' % (len(out), len(out) - len(prev), len(changed)))
    for k, a, b in changed:
        print('  %-7s %-14s → %s' % (k, a, b))

if __name__ == '__main__':
    main()
