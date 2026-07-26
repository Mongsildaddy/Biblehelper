#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ko_gloss_merged.json 의 한국어 뜻을 books/_lex.json 에 반영."""
import json, os
here=os.path.dirname(__file__)
merged=json.load(open(os.path.join(here,"ko_gloss_merged.json"),encoding="utf-8"))
lexpath=os.path.join(here,"..","books","_lex.json")
lex=json.load(open(lexpath,encoding="utf-8"))
def kog(s):
    for c in [s,s[:5]]:
        if c in merged: return merged[c]
    return ""
add=0
for s,L in lex.items():
    if not L.get("ko"):
        k=kog(s)
        if k: L["ko"]=k; add+=1
json.dump(lex,open(lexpath,"w"),ensure_ascii=False)
print(f"_lex.json 갱신: 신규 {add}개 반영 · 총 {sum(1 for L in lex.values() if L.get('ko'))}/{len(lex)} 커버")
