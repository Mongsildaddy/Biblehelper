#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tools/koglo/*.json 의 한국어 '낱말 뜻'(gloss)을 books/_lex.json 의 ko 필드로 병합.

kd(상세 정의)를 다루는 merge_kodef.py 와 짝이다. 이쪽은 낱말 칩에 바로 찍히는
짧은 뜻이라 길면 줄이 깨진다. 그래서 길이 상한을 둔다.

koglo/*.json 형식:  { "G2424": "예수", ... }
검증:
  - 렉시콘에 없는 스트롱번호 경고
  - 한글이 한 글자도 없는(번역 안 된) 값 경고
  - 너무 긴 값 경고 (칩 레이아웃이 깨진다)
  - 파일 간 중복 경고

실행:  python tools/merge_koglo.py
"""
import json, os, glob, re

HERE = os.path.dirname(os.path.abspath(__file__))
LEXPATH = os.path.join(HERE, "..", "books", "_lex.json")
HANGUL = re.compile(r"[가-힣]")
MAXLEN = 18   # 칩 한 칸에 무리 없이 들어가는 길이


def main():
    lex = json.load(open(LEXPATH, encoding="utf-8"))
    files = sorted(glob.glob(os.path.join(HERE, "koglo", "*.json")))
    if not files:
        print("tools/koglo/ 에 번역 파일이 없습니다.")
        return

    merged, unknown, nohangul, toolong, dup = 0, [], [], [], []
    seen = {}
    for f in files:
        data = json.load(open(f, encoding="utf-8"))
        for s, ko in data.items():
            ko = ko.strip()
            if s in seen:
                dup.append(f"{s} ({seen[s]} / {os.path.basename(f)})")
            seen[s] = os.path.basename(f)
            if s not in lex:
                unknown.append(s)
                continue
            if not HANGUL.search(ko):
                nohangul.append(s)
                continue
            if len(ko) > MAXLEN:
                toolong.append(f"{s}({len(ko)}자)")
            lex[s]["ko"] = ko
            merged += 1
        print(f"  {os.path.basename(f):10s} {len(data):4d}개")

    json.dump(lex, open(LEXPATH, "w", encoding="utf-8"), ensure_ascii=False)

    have = sum(1 for L in lex.values() if L.get("ko"))
    print(f"\n_lex.json 병합 완료: {merged}개 반영 · 낱말 뜻 보유 {have}/{len(lex)}")
    print(f"파일 크기: {os.path.getsize(LEXPATH)/1048576:.2f}MB")
    if unknown:
        print(f"  ! 렉시콘에 없는 번호 {len(unknown)}개: {unknown[:8]}")
    if nohangul:
        print(f"  ! 한글 없음(미번역 의심) {len(nohangul)}개: {nohangul[:8]}")
    if toolong:
        print(f"  ! 너무 김({MAXLEN}자 초과) {len(toolong)}개: {toolong[:8]}")
    if dup:
        print(f"  ! 중복 {len(dup)}개: {dup[:5]}")


if __name__ == "__main__":
    main()
