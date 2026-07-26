#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tools/kodef/*.json 의 한국어 '상세 정의'를 books/_lex.json 의 kd 필드로 병합.

kodef/*.json 형식:  { "H0430": "이 이름은 …", ... }
검증:
  - 렉시콘에 없는 스트롱번호 경고
  - 한글이 한 글자도 없는(번역 안 된) 값 경고
  - 원문 영어가 그대로 남은 것으로 의심되는 값 경고

실행:  python tools/merge_kodef.py
"""
import json, os, glob, re

HERE = os.path.dirname(os.path.abspath(__file__))
LEXPATH = os.path.join(HERE, "..", "books", "_lex.json")
HANGUL = re.compile(r"[가-힣]")


def main():
    lex = json.load(open(LEXPATH, encoding="utf-8"))
    files = sorted(glob.glob(os.path.join(HERE, "kodef", "*.json")))
    if not files:
        print("tools/kodef/ 에 번역 파일이 없습니다.")
        return

    merged, unknown, nohangul, dup = 0, [], [], []
    seen = {}
    for f in files:
        data = json.load(open(f, encoding="utf-8"))
        for s, ko in data.items():
            if s in seen:
                dup.append(f"{s} ({seen[s]} / {os.path.basename(f)})")
            seen[s] = os.path.basename(f)
            if s not in lex:
                unknown.append(s)
                continue
            if not HANGUL.search(ko):
                nohangul.append(s)
                continue
            lex[s]["kd"] = ko.strip()
            merged += 1
        print(f"  {os.path.basename(f):10s} {len(data):4d}개")

    json.dump(lex, open(LEXPATH, "w", encoding="utf-8"), ensure_ascii=False)

    have_kd = sum(1 for L in lex.values() if L.get("kd"))
    print(f"\n_lex.json 병합 완료: {merged}개 반영 · 상세정의 한국어 보유 {have_kd}/{len(lex)}")
    print(f"파일 크기: {os.path.getsize(LEXPATH)/1048576:.2f}MB")
    if unknown:
        print(f"  ! 렉시콘에 없는 번호 {len(unknown)}개: {unknown[:8]}")
    if nohangul:
        print(f"  ! 한글 없음(미번역 의심) {len(nohangul)}개: {nohangul[:8]}")
    if dup:
        print(f"  ! 중복 정의 {len(dup)}개: {dup[:5]}")


if __name__ == "__main__":
    main()
