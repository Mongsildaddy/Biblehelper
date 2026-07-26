# -*- coding: utf-8 -*-
"""tools/sumdef/*.json 의 요약문을 books/_sum.json 으로 합친다.

키 형식
  "H0216|0"  창세기에서의 쓰임 (스트롱번호|책인덱스)
  "H0216"    성경 전체에서의 쓰임 (책별 요약이 없을 때 대신 보여 준다)

여러 번 실행해도 결과가 같다. 배치를 추가할 때마다 다시 돌리면 된다.
"""
import glob
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
OUT = os.path.join(ROOT, "books", "_sum.json")
HANGUL = re.compile(r"[가-힣]")
KEY = re.compile(r"^[GH]\d{4}[a-z]?(\|\d+)?$")


def main():
    lex = json.load(open(os.path.join(ROOT, "books", "_lex.json"), encoding="utf-8"))
    mani = json.load(open(os.path.join(ROOT, "books", "_manifest.json"), encoding="utf-8"))

    out, seen = {}, {}
    bad_key, unknown, nohangul, tooshort, dup = [], [], [], [], []

    for f in sorted(glob.glob(os.path.join(HERE, "sumdef", "*.json"))):
        name = os.path.basename(f)
        data = json.load(open(f, encoding="utf-8"))
        print("  %-12s %4d개" % (name, len(data)))
        for k, v in data.items():
            if not KEY.match(k):
                bad_key.append(k)
                continue
            s, _, bi = k.partition("|")
            if s not in lex:
                unknown.append(k)
                continue
            if bi and not (0 <= int(bi) < len(mani)):
                unknown.append(k)
                continue
            if not HANGUL.search(v):
                nohangul.append(k)
                continue
            if len(v.strip()) < 40:
                tooshort.append(k)
                continue
            if k in seen:
                dup.append("%s (%s ↔ %s)" % (k, seen[k], name))
            seen[k] = name
            out[k] = v.strip()

    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)

    books = sum(1 for k in out if "|" in k)
    print("\n_sum.json 저장 완료: %d개 (책별 %d · 전체 %d)" % (len(out), books, len(out) - books))
    print("파일 크기: %.2fKB" % (os.path.getsize(OUT) / 1024.0))

    for label, items in (("키 형식 오류", bad_key), ("모르는 스트롱/책", unknown),
                         ("한글 없음", nohangul), ("너무 짧음", tooshort), ("중복", dup)):
        if items:
            print("\n[%s] %d건" % (label, len(items)))
            for x in items[:20]:
                print("  " + x)


if __name__ == "__main__":
    main()
