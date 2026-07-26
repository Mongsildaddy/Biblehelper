#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
미크라 · 롱테일 gloss 자동 번역 파이프라인 (Anthropic Message Batches API)
==========================================================================
남은 미번역 히브리어/아람어 gloss를 배치로 한국어 번역 → 검증 → 병합.

전제:
  pip install anthropic
  export ANTHROPIC_API_KEY=sk-...
사용:
  python automate_translation.py --dry-run      # 요청만 생성·미리보기 (API 호출 X)
  python automate_translation.py --submit       # 배치 제출 후 배치ID 출력
  python automate_translation.py --collect BATCH_ID   # 완료된 배치 결과 수거·병합

입력:  remaining_glosses.json  [{strong,n,aram,gloss_en,translit}, ...]
출력:  ko_gloss_auto.json (신규 번역)  →  ko_gloss_merged.json 에 병합
"""
import os, json, time, argparse, re, sys

GLOSS_PER_REQ = 50           # 요청당 gloss 수
MODEL = "claude-sonnet-4-5"  # 번역 모델(비용/품질 균형). 최신 모델명은 docs.claude.com에서 확인.
MAX_TOKENS = 4096

# ── 용어집: 배치1~7에서 고정한 역어 기준 (일관성 유지의 핵심) ──
SYSTEM_PROMPT = """당신은 히브리어·아람어 성경 렉시콘을 한국어로 번역하는 전문 번역가다.
입력은 스트롱번호별 '영문 gloss'(짧은 뜻) 목록이다. 각 항목을 개역한글 성경의 표준 역어로 옮겨라.

[규칙]
- 짧은 사전 뜻으로 (1~6자 위주). 여러 뜻은 '·'로 구분 (예: "만들다·행하다").
- 고유명사(인명·지명)는 개역한글 표기로: David→다윗, Jerusalem→예루살렘, Nebuchadnezzar→느부갓네살,
  Zion→시온, Egypt→애굽, Babylon→바벨론, Assyria→앗수르 등.
- 신학 용어 통일: God→하나님, LORD(YHWH)→여호와, covenant→언약, righteousness→의(義),
  atonement→속죄, holy→거룩한, grace→은혜, love→사랑, soul→영혼, sin→죄, praise→찬양하다.
- 문법 약어는 풀되 짧게: n.m.→(생략), v.→동사 뜻만.
- 오분류 교정: 영문 gloss가 희귀 뜻(지명 등)으로 보여도, 그 단어의 대표 뜻을 우선하라.
- aram=true 항목은 아람어다. 뜻 끝에 "(아람)"을 붙여라. (예: house→"집(아람)")
- 확신 없으면 지어내지 말고 gloss의 축자 뜻을 그대로 옮겨라.

[출력] 반드시 JSON만. 설명·마크다운 금지. 형식:
{"H1732":"다윗","H0430":"하나님", ...}
스트롱번호를 키로, 한국어 뜻을 값으로."""

def build_requests(rows):
    reqs=[]
    for i in range(0, len(rows), GLOSS_PER_REQ):
        chunk=rows[i:i+GLOSS_PER_REQ]
        items={r["strong"]:{"gloss_en":r["gloss_en"],"aram":r["aram"]} for r in chunk}
        user=("다음 항목을 규칙대로 한국어로 번역해 JSON으로 반환하라:\n"
              +json.dumps(items,ensure_ascii=False))
        reqs.append({
            "custom_id": f"chunk-{i//GLOSS_PER_REQ:04d}",
            "params": {
                "model": MODEL, "max_tokens": MAX_TOKENS,
                "system": SYSTEM_PROMPT,
                "messages": [{"role":"user","content":user}],
            },
        })
    return reqs

def validate(ko_map, rows):
    """감수 없음 대비 자동 검증. 문제 항목 리스트 반환."""
    valid={}; issues=[]
    src={r["strong"]:r for r in rows}
    for s,ko in ko_map.items():
        if s not in src: issues.append(("미지의 키",s)); continue
        if not ko or not ko.strip(): issues.append(("빈값",s)); continue
        if re.search(r"[A-Za-z]{3,}", ko): issues.append(("영문잔존",s,ko)); continue
        if src[s]["aram"] and "아람" not in ko: ko=ko+"(아람)"  # 아람 표기 보정
        valid[s]=ko
    return valid, issues

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--dry-run",action="store_true")
    ap.add_argument("--submit",action="store_true")
    ap.add_argument("--collect",metavar="BATCH_ID")
    ap.add_argument("--input",default="remaining_glosses.json")
    args=ap.parse_args()
    rows=json.load(open(args.input,encoding="utf-8"))

    if args.dry_run:
        reqs=build_requests(rows)
        print(f"[dry-run] gloss {len(rows)} → 요청 {len(reqs)}개 (요청당 {GLOSS_PER_REQ})")
        print("첫 요청 미리보기:")
        print(json.dumps(reqs[0],ensure_ascii=False,indent=1)[:900])
        return

    import anthropic
    client=anthropic.Anthropic()  # ANTHROPIC_API_KEY 환경변수 사용

    if args.submit:
        reqs=build_requests(rows)
        batch=client.messages.batches.create(requests=reqs)
        print("제출 완료. BATCH_ID =", batch.id, "| 상태:", batch.processing_status)
        print(f"수거: python {sys.argv[0]} --collect {batch.id}")
        return

    if args.collect:
        b=client.messages.batches.retrieve(args.collect)
        if b.processing_status!="ended":
            print("아직 처리 중:",b.processing_status,"— 나중에 다시 시도"); return
        ko_map={}
        for res in client.messages.batches.results(args.collect):
            if res.result.type!="succeeded": continue
            txt="".join(blk.text for blk in res.result.message.content if blk.type=="text")
            txt=re.sub(r"^```json|```$","",txt.strip()).strip()
            try: ko_map.update(json.loads(txt))
            except Exception as e: print("파싱 실패",res.custom_id,e)
        valid,issues=validate(ko_map,rows)
        print(f"수거: {len(ko_map)} 번역 · 검증통과 {len(valid)} · 이슈 {len(issues)}")
        if issues: print("이슈 샘플:",issues[:10])
        json.dump(valid,open("ko_gloss_auto.json","w"),ensure_ascii=False,indent=1)
        # 병합
        merged=json.load(open("ko_gloss_merged.json",encoding="utf-8"))
        add=0
        for s,ko in valid.items():
            if s[:5] not in merged: merged[s[:5]]=ko; add+=1
        json.dump(merged,open("ko_gloss_merged.json","w"),ensure_ascii=False)
        print(f"병합: 신규 {add}개 → 통합 사전 {len(merged)}개")
        print("다음: python tools/rebuild_lex.py  (ko_gloss_merged → books/_lex.json 반영)")
        return
    ap.print_help()

if __name__=="__main__":
    main()
