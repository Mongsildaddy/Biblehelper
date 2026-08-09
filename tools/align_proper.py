# -*- coding: utf-8 -*-
"""개역한글 본문에서 고유명사 표기를 뽑아낸다.

고유명사는 번역이 아니라 음역이라, 같은 스트롱번호가 나오는 절마다 개역한글
본문에 거의 같은 한글 덩어리가 나타난다. 그 성질을 이용해 후보를 고른다.

  점수 = (그 낱말이 있는 절에서 나온 횟수) / (성경 전체에서 나온 횟수)

1에 가까울수록 '이 낱말이 있는 곳에서만 나오는 한글 덩어리'라는 뜻이다.
정답을 이미 아는 낱말로 먼저 정확도를 재고, 기준을 넘긴 것만 채택한다.
"""
import json, os, re, sys, io, collections, difflib

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HAN = re.compile(r'[가-힣]+')
MINLEN, MAXLEN = 2, 6

def load():
    """[(스트롱번호 집합, 한국어 본문), ...] 를 절 단위로 모은다."""
    verses = []
    for fn in sorted(os.listdir(os.path.join(ROOT, 'books'))):
        if not fn.endswith('.json') or fn.startswith('_'):
            continue
        d = json.load(open(os.path.join(ROOT, 'books', fn), encoding='utf-8'))
        kor, heb = d.get('kor') or {}, d.get('heb') or {}
        for ch, vs in heb.items():
            kch = kor.get(ch) or {}
            for v, words in vs.items():
                t = kch.get(v)
                if not t:
                    continue
                verses.append(({w['s'] for w in words if w.get('s')}, t))
    return verses

"""한글 후보를 로마자로 되돌려 음역 필드(t)와 대조한다.

본문 동시등장만으로는 늘 붙어 다니는 이름을 가르지 못한다(나답과 아비후,
셈과 야벳, 학개와 스가랴). 고유명사는 음역이므로 소리를 맞춰 보면 갈린다."""
CHO = ['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h']
JUNG = ['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i']
JONG = ['','k','k','k','n','n','n','t','l','l','l','l','l','l','l','l','m','p','p','t','t','ng','t','t','k','t','p','t']

def roman(hangul):
    out = []
    for c in hangul:
        o = ord(c) - 0xAC00
        if 0 <= o < 11172:
            out.append(CHO[o // 588] + JUNG[(o % 588) // 28] + JONG[o % 28])
        else:
            out.append(c)
    return ''.join(out)

# 개역한글 음역과 학술 음역은 자음 표기가 갈린다(v/b, k/q, t/th, s/ts 등).
# 같은 소리로 뭉뚱그린 뒤 모음을 지워 자음 뼈대만 비교한다.
FOLD = str.maketrans({'v':'b','p':'b','f':'b','q':'k','g':'k','c':'k','x':'k',
                      'd':'t','z':'s','j':'s','r':'l','w':'','y':'','h':''})

def skeleton(s):
    s = re.sub(r'[^a-z]', '', s.lower())
    s = s.replace('sh', 's').replace('ch', 's').replace('ts', 's').replace('th', 't')
    s = s.translate(FOLD)
    return re.sub(r'[aeiou]+', '', s)

def sound_match(hangul, translit):
    """자음 뼈대가 얼마나 겹치는지 0~1 로 돌려준다."""
    a, b = skeleton(roman(hangul)), skeleton(translit)
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()

def grams(text):
    """한글 덩어리에서 2~6자 부분문자열을 뽑는다. 조사가 붙어도 어근이 걸린다."""
    out = set()
    for run in HAN.findall(text):
        for L in range(MINLEN, MAXLEN + 1):
            for i in range(len(run) - L + 1):
                out.add(run[i:i + L])
    return out

def build(verses):
    df = collections.Counter()          # 전체 절 빈도
    by_strong = collections.defaultdict(list)
    cache = []
    for idx, (ss, t) in enumerate(verses):
        g = grams(t)
        cache.append(g)
        df.update(g)
        for s in ss:
            by_strong[s].append(idx)
    return df, by_strong, cache

# 이름 뒤에 흔히 붙는 조사·접미. 긴 것부터 벗겨야 '와'가 '와서'를 깎지 않는다.
JOSA = ['에게서','으로서','이라서','에서는','께서는','이라고','에게는','라고도',
        '으로는','에게도','이라는','께서','에게','에서','으로','이라','과는','와는',
        '이며','으며','이나','이니','이여','이라','까지','부터','마다','조차','처럼',
        '보다','한테','더러','이든','이고','으로','이란','은','는','이','가','을','를',
        '의','와','과','도','만','로','랑','아','야','여','께','서','나','니','며','고','라']

def strip_josa(g):
    for j in JOSA:
        if len(g) - len(j) >= 2 and g.endswith(j):
            return g[:-len(j)]
    return g

def candidates(s, df, by_strong, cache, translit, topn=3):
    idxs = by_strong.get(s) or []
    n = len(idxs)
    if not n:
        return []
    hit = collections.Counter()
    for i in idxs:
        hit.update(cache[i])
    scored = []
    for g, c in hit.items():
        if c < 2 and n > 1:
            continue
        recall = c / n                   # 그 낱말이 나오는 절 중 몇 %에 등장하나
        prec = c / df[g]                 # 그 덩어리가 나오는 절 중 몇 %가 이 낱말인가
        if recall < 0.55 or prec < 0.55:
            continue
        base = strip_josa(g)
        # 소리가 맞아야 한다. 늘 붙어 다니는 다른 이름은 여기서 걸러진다.
        snd = sound_match(base, translit)
        if snd < 0.5:
            continue
        scored.append((snd * snd * prec * recall, recall, prec, snd, len(base), base))
    # 소리 일치를 제곱해 크게 반영한다. 같은 점수면 긴 쪽(온전한 이름)을 고른다.
    scored.sort(key=lambda x: (-x[0], -x[4]))
    out = []
    for sc in scored:
        if any(sc[5] == o[5] or sc[5] in o[5] for o in out):
            continue
        out.append(sc)
        if len(out) >= topn:
            break
    return out

def main():
    print('본문 읽는 중...')
    verses = load()
    print('절 %d개' % len(verses))
    print('부분문자열 색인 만드는 중...')
    df, by_strong, cache = build(verses)
    print('덩어리 %d종' % len(df))

    lex = json.load(open(os.path.join(ROOT, 'books', '_lex.json'), encoding='utf-8'))
    known = {k: v['ko'] for k, v in lex.items()
             if (v or {}).get('ko') and re.match(r'^[A-Z]', str(v.get('ge') or ''))}

    print('\n=== 정답을 아는 고유명사 %d개로 검증 ===' % len(known))
    ok = near = wrong = none = 0
    misses = []
    for s, truth in known.items():
        cs = candidates(s, df, by_strong, cache, lex[s].get('t') or '')
        if not cs:
            none += 1
            continue
        top = cs[0][5]
        if top == truth:
            ok += 1
        elif top in truth or truth in top:
            near += 1
        else:
            wrong += 1
            if len(misses) < 12:
                misses.append((s, truth, top, cs[0][1], cs[0][3]))
    tried = ok + near + wrong
    print('후보 나온 것 %d개 / 못 뽑은 것 %d개' % (tried, none))
    if tried:
        print('  정확히 일치      %5d개  %.1f%%' % (ok, 100 * ok / tried))
        print('  포함 관계(부분)  %5d개  %.1f%%' % (near, 100 * near / tried))
        print('  틀림             %5d개  %.1f%%' % (wrong, 100 * wrong / tried))
    print('\n틀린 표본')
    for s, truth, top, r, snd in misses:
        print('  %-7s 정답 %-10s 후보 %-10s (재현 %.2f 소리 %.2f)' % (s, truth, top, r, snd))

if __name__ == '__main__':
    main()
