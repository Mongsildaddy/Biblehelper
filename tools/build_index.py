#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""스트롱번호별 성경 용례(콘코던스) 색인 생성.

books/*.json 을 스캔해 스트롱번호마다 "어느 책 몇 장 몇 절에 나오는지"를
books/idx/<접두어>.json 샤드 파일로 저장한다.

샤드 키:  스트롱번호 앞 3글자 (H0430 -> H04, G3588 -> G35)
샤드 내용: { "H0430": {"n": 총출현횟수, "r": "0:1.1,1.26|2:3.4"} }
           r = 책인덱스:장.절,장.절|책인덱스:...
           책인덱스는 _manifest.json 의 배열 순서.
           같은 절에 같은 단어가 여러 번 나와도 절은 한 번만 기록(n 은 전체 횟수).

실행:  python tools/build_index.py
"""
import json, os, collections

HERE = os.path.dirname(os.path.abspath(__file__))
BOOKS = os.path.join(HERE, "..", "books")
OUTDIR = os.path.join(BOOKS, "idx")


def main():
    manifest = json.load(open(os.path.join(BOOKS, "_manifest.json"), encoding="utf-8"))

    # strong -> {book_idx -> {chapter -> [verse, ...]}} , strong -> 총 출현 수
    refs = collections.defaultdict(lambda: collections.defaultdict(dict))
    totals = collections.Counter()

    for bi, meta in enumerate(manifest):
        path = os.path.join(BOOKS, meta["osis"] + ".json")
        if not os.path.exists(path):
            print(f"  ! {meta['osis']}.json 없음 - 건너뜀")
            continue
        book = json.load(open(path, encoding="utf-8"))
        for ch, verses in book.get("heb", {}).items():
            for v, words in verses.items():
                for w in words:
                    s = w.get("s")
                    if not s:
                        continue  # 스트롱번호 없는 토큰은 색인 제외
                    totals[s] += 1
                    # dict 를 순서 있는 집합처럼 사용 (중복 절 제거 + 삽입순 유지)
                    refs[s][bi].setdefault(ch, {})[v] = None
        print(f"  {meta['osis']:6s} 완료")

    # 샤드로 묶어 직렬화
    shards = collections.defaultdict(dict)
    for s, bmap in refs.items():
        parts = []
        for bi in sorted(bmap):
            chmap = bmap[bi]
            vs = []
            for ch in sorted(chmap, key=lambda x: int(x)):
                for v in sorted(chmap[ch], key=lambda x: int(x)):
                    vs.append(f"{ch}.{v}")
            parts.append(f"{bi}:" + ",".join(vs))
        shards[s[:3]][s] = {"n": totals[s], "r": "|".join(parts)}

    os.makedirs(OUTDIR, exist_ok=True)
    for old in os.listdir(OUTDIR):
        if old.endswith(".json"):
            os.remove(os.path.join(OUTDIR, old))

    total_bytes = 0
    for shard, data in shards.items():
        p = os.path.join(OUTDIR, shard + ".json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        total_bytes += os.path.getsize(p)

    biggest = max(
        ((os.path.getsize(os.path.join(OUTDIR, f)), f) for f in os.listdir(OUTDIR)),
        default=(0, "-"),
    )
    print(
        f"\n색인 완료: 스트롱번호 {len(refs):,}개 · 총 출현 {sum(totals.values()):,}회\n"
        f"샤드 {len(shards)}개 · 합계 {total_bytes/1048576:.1f}MB · "
        f"최대 샤드 {biggest[1]} ({biggest[0]/1024:.0f}KB)"
    )


if __name__ == "__main__":
    main()
