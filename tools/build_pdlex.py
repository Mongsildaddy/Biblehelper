#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""히브리어 상세 정의를 퍼블릭도메인 소스로 교체한다.

바꾸는 이유
  기존 정의는 Online Bible이 배포한 Abridged BDB 라서 재배포·상업 이용
  조건이 불분명했다. 광고를 붙일 계획이라 라이선스가 확실한 소스로
  갈아끼운다.

새 소스 (둘 다 openscriptures/HebrewLexicon, CC BY 4.0 · 본문은 PD)
  BrownDriverBriggs.xml  BDB 1906 원문      → L['d']
  HebrewStrong.xml       스트롱 히브리어사전 → L['sd']
  AugIndex.xml + LexicalIndex.xml 로 H2617a 같은 확장 스트롱번호를 잇는다.

한국어 상세정의(kd)는 옛 원문을 번역한 것이라 그대로 두면 파생물이 된다.
히브리어 kd는 지운 뒤 새 원문 기준으로 다시 작성한다. 헬라어(TBESG /
Abbott-Smith)는 문제가 없으므로 손대지 않는다.

    python tools/build_pdlex.py
"""
import json, os, re, sys, io
import xml.etree.ElementTree as ET

if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
PD   = os.path.join(HERE, 'pdlex')
LEXP = os.path.join(HERE, '..', 'books', '_lex.json')
DROP = os.path.join(HERE, '_kd_todo.json')   # 다시 번역해야 할 목록

tag = lambda t: re.sub(r'\{[^}]*\}', '', t)


def need(name):
    p = os.path.join(PD, name)
    if not os.path.exists(p):
        sys.exit(f'없음: {p}\n  tools/pdlex/ 에 openscriptures/HebrewLexicon 파일을 내려받아 주세요.')
    return p


SKIP = ('status', 'note', 'ref', 'page')


def flatten(el, top=True):
    """엘리먼트 안의 글자를 한 줄로 편다.

    BDB는 뜻갈래를 <sense>로 감싸는데 그냥 이어 붙이면 앞뒤 뜻이 붙어
    'light of faceYahweh' 처럼 읽힌다. <sense> 앞에 구분자를 넣어 준다.
    """
    out = [el.text or '']
    for c in el:
        t = tag(c.tag)
        if t in SKIP:
            out.append(c.tail or '')
            continue
        if t == 'sense':
            out.append(' § ' + flatten(c, False))
        else:
            out.append(flatten(c, False))
        out.append(c.tail or '')
    s = ''.join(out)
    if not top:
        return s
    s = ' '.join(s.split())
    s = re.sub(r'\s+([,;.:])', r'\1', s)          # 구두점 앞 공백
    s = re.sub(r'(?:\s*§\s*)+', ' § ', s)          # 구분자 중복
    s = re.sub(r'§\s*([,;.:])', r'\1 §', s)
    parts = [p.strip(' ,;.') for p in s.split('§')]
    s = '; '.join(p for p in parts if p)
    s = re.sub(r':\s*;', ':', s)        # 'of man:;' → 'of man:'
    s = re.sub(r';\s*;', ';', s)
    return s.strip(' ,;:')


def load_maps():
    aug = {}
    for w in ET.parse(need('AugIndex.xml')).getroot().iter():
        if tag(w.tag) == 'w' and w.get('aug'):
            aug[w.get('aug')] = (w.text or '').strip()
    lidx = {}
    for e in ET.parse(need('LexicalIndex.xml')).getroot().iter():
        if tag(e.tag) != 'entry':
            continue
        for c in e:
            if tag(c.tag) == 'xref' and c.get('bdb'):
                lidx[e.get('id')] = c.get('bdb')
    bdb = {}
    for e in ET.parse(need('BrownDriverBriggs.xml')).getroot().iter():
        if tag(e.tag) == 'entry' and e.get('id'):
            bdb[e.get('id')] = flatten(e)
    strong = {}
    for e in ET.parse(need('HebrewStrong.xml')).getroot().iter():
        if tag(e.tag) != 'entry' or not e.get('id'):
            continue
        mean = usage = ''
        for c in e:
            if tag(c.tag) == 'meaning':
                mean = flatten(c)
            elif tag(c.tag) == 'usage':
                usage = flatten(c)
        parts = [x for x in (mean, usage) if len(x) > 1]
        strong[e.get('id')] = ' — '.join(parts)
    return aug, lidx, bdb, strong


MIN = 3    # 'king' 처럼 짧아도 뜻이면 살린다. 빈 껍데기만 거른다


def has_meaning(s, lemma_ok=True):
    """히브리어 표제어와 숫자만 남은 껍데기인지 본다."""
    body = re.sub(r'[֐-׿‏‎\s\d.,;:()\[\]×]+', '', s)
    return len(body) >= MIN


def main():
    aug, lidx, bdb, strong = load_maps()
    print(f'BDB {len(bdb)} · 스트롱 {len(strong)} · 색인 {len(aug)}/{len(lidx)}')

    lex = json.load(open(LEXP, encoding='utf-8'))
    n_bdb = n_str = n_both = n_none = 0
    dropped = {}

    for k, L in lex.items():
        if k[0] != 'H':
            continue
        a = k[1:].lstrip('0') or '0'
        d = bdb.get(lidx.get(aug.get(a, ''), ''), '')
        s = strong.get('H' + str(int(re.match(r'H(\d+)', k).group(1))), '')
        d = d if has_meaning(d) else ''
        s = s if has_meaning(s) else ''

        if d:
            L['d'] = d
        else:
            L.pop('d', None)
        if s:
            L['sd'] = s
        else:
            L.pop('sd', None)

        if d and s:   n_both += 1
        elif d:       n_bdb  += 1
        elif s:       n_str  += 1
        else:         n_none += 1

        # 옛 원문에서 번역한 한국어 상세정의는 버리고 다시 만든다
        if L.pop('kd', None):
            dropped[k] = {'t': L.get('t', ''), 'ge': L.get('ge', ''),
                          'ko': L.get('ko', ''), 'd': d, 'sd': s}

    json.dump(lex, open(LEXP, 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))
    json.dump(dropped, open(DROP, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

    tot = n_both + n_bdb + n_str
    h = sum(1 for k in lex if k[0] == 'H')
    print(f'히브리어 {h}개 → 둘 다 {n_both} · BDB만 {n_bdb} · 스트롱만 {n_str} · 없음 {n_none}')
    print(f'정의 보유 {tot}개 ({tot / h * 100:.1f}%)')
    print(f'다시 번역할 한국어 상세정의 {len(dropped)}개 → {os.path.relpath(DROP, os.getcwd())}')
    print(f'_lex.json {os.path.getsize(LEXP) / 1024 / 1024:.2f}MB')


if __name__ == '__main__':
    main()
