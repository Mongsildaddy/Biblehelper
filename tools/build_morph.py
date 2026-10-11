# -*- coding: utf-8 -*-
"""OSHB 형태 코드를 books/*.json 의 히브리어 낱말에 붙인다.

예전 빌드는 OSHB 의 morph 를 '명사·여성·단수'처럼 미리 풀어 m 에 넣었는데,
그 과정에서 동사의 인칭·성·수, 명사의 연계형/절대형, 접두어(전치사·관사·
접속사) 정보가 빠졌고, 대명접미사(Sp3ms 등)는 풀리지 않은 채 남았다.

이번에는 원본 코드를 그대로 x 필드에 싣고(예: 'HR/Ncfsa'), 풀이는 화면의
JS 가 한다. 코드는 짧아서 파일이 거의 커지지 않고, 풀이 방식을 바꿀 때
데이터를 다시 만들 필요가 없다.

    python tools/build_morph.py          맞춰 보기만 (파일을 쓰지 않음)
    python tools/build_morph.py --write  x 필드를 써 넣음

전제: tools/oshb 에 https://github.com/openscriptures/morphhb 를 받아 둔다.
      (CC BY 4.0, 저장소에는 넣지 않음)
"""
import json, os, re, sys, io, unicodedata
import xml.etree.ElementTree as ET

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WLC = os.path.join(ROOT, 'tools', 'oshb', 'wlc')
NS = {'o': 'http://www.bibletechnologies.net/2003/OSIS/namespace'}

def norm(s):
    return unicodedata.normalize('NFC', s or '').strip()

# 옛 빌드가 큰 글자·작은 글자 표시(<seg type="x-large">ע</seg>)를 글자 그대로
# 본문에 넣어 두었다(쉐마의 שְׁמַע 등 11곳). 태그를 걷어 낸다.
SEG = re.compile(r'</?seg[^>]*>')

# 우리 데이터는 요엘과 말라기만 영어 성경식 장절이다. OSHB(히브리어식) 장절로 바꾼다.
#   요엘 2:28~32 = 히 3:1~5, 요엘 3:n = 히 4:n / 말라기 4:n = 히 3:(18+n)
def heb_ref(osis, ch, vn):
    c, v = int(ch), int(vn)
    if osis == 'Joel':
        if c == 2 and v >= 28:
            return '3', str(v - 27)
        if c == 3:
            return '4', str(v)
    if osis == 'Mal' and c == 4:
        return '3', str(18 + v)
    return ch, vn

def oshb_verses(path):
    """{'1': {'1': [(text, morph), ...]}} — 절 안의 w 를 순서대로."""
    out = {}
    root = ET.parse(path).getroot()
    for v in root.iter('{%s}verse' % NS['o']):
        oid = v.get('osisID') or ''
        parts = oid.split('.')
        if len(parts) != 3:
            continue
        _, ch, vn = parts
        ws = [(norm(''.join(w.itertext())), w.get('morph') or '') for w in v.iter('{%s}w' % NS['o'])]
        out.setdefault(ch, {})[vn] = ws
    return out

def main():
    write = '--write' in sys.argv
    books = os.path.join(ROOT, 'books')
    tot_w = tot_ok = 0
    bad_books = []
    for fn in sorted(os.listdir(WLC)):
        if not fn.endswith('.xml'):
            continue
        osis = fn[:-4]
        bp = os.path.join(books, osis + '.json')
        if not os.path.exists(bp):
            print('  우리 데이터에 없는 책:', osis)
            continue
        src = oshb_verses(os.path.join(WLC, fn))
        d = json.load(open(bp, encoding='utf-8'))
        heb = d.get('heb') or {}
        bw = bok = 0
        miss = []
        for ch, vs in heb.items():
            for vn, words in vs.items():
                hc, hv = heb_ref(osis, ch, vn)
                ref = (src.get(hc) or {}).get(hv)
                for w in words:
                    if '<seg' in (w.get('h') or ''):
                        w['h'] = SEG.sub('', w['h'])
                if ref is None:
                    miss.append('%s:%s 원본에 절 없음' % (ch, vn))
                    bw += len(words)
                    continue
                # 우리 낱말과 원본 낱말을 글자로 맞춰 간다. 수가 같고 글자가 같으면 순서대로.
                j = 0
                for w in words:
                    bw += 1
                    t = norm(w.get('h'))
                    k = j
                    while k < len(ref) and ref[k][0] != t:
                        k += 1
                    if k < len(ref):
                        bok += 1
                        if write:
                            w['x'] = ref[k][1]
                        j = k + 1
                    else:
                        if len(miss) < 5:
                            miss.append('%s:%s «%s» 짝 없음' % (ch, vn, t))
        tot_w += bw
        tot_ok += bok
        flag = '' if bw == bok else '  ← 불일치 %d' % (bw - bok)
        print('%-6s 낱말 %6d  맞춤 %6d%s' % (osis, bw, bok, flag))
        if bw != bok:
            bad_books.append(osis)
            for m in miss[:5]:
                print('        ', m)
        if write:
            json.dump(d, open(bp, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('\n구약 전체 낱말 %d개 중 %d개 맞춤 (%.3f%%)' % (tot_w, tot_ok, 100 * tot_ok / max(1, tot_w)))
    if not write:
        print('파일은 쓰지 않았습니다. --write 로 실행하면 x 필드를 넣습니다.')

if __name__ == '__main__':
    main()
