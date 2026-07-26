# -*- coding: utf-8 -*-
"""핵심 단어×책 조합을 골라 요약 작업 목록(_sum_todo.jsonl)을 만든다.

빈도 상위만 쓰면 관사·전치사가 대부분이라 요약할 내용이 없다.
그래서 설교 준비에서 실제로 자주 찾는 낱말을 직접 지정하고,
각 낱말이 가장 집중적으로 나타나는 책 몇 권씩을 뽑는다.
"""
import glob
import io
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")

# 낱말당 뽑을 책 수 (구절 수 상위부터)
PER_WORD = 3
# 이보다 구절이 적은 책은 요약해도 근거가 빈약하므로 건너뛴다
MIN_VERSES = 7
# 첫 번째 책이 아니라면, 그 낱말 전체 용례의 이 비율 이상을 차지해야 뽑는다.
# (여러 책에 얇게 흩어진 조합은 굳이 미리 만들어 둘 값어치가 없다)
MIN_SHARE = 0.05

WORDS = [
    # ── 창조·빛과 어둠 ──
    "H0216", "H2822", "H4325", "H0776", "H8064",
    # ── 언약과 사랑 ──
    "H1285", "H2617a", "H0157", "H1288",
    # ── 의와 공의, 율법 ──
    "H6666", "H6662", "H4941", "H8451", "H4687",
    # ── 거룩과 예배 ──
    "H6944", "H6942", "H2077", "H4196", "H3548", "H7676",
    # ── 영·혼·마음 ──
    "H7307", "H5315", "H3820a", "H2416a",
    # ── 죄와 속죄 ──
    "H2403b", "H5771", "H6588", "H2398", "H3722a", "H1818", "H1350a",
    # ── 구원과 평강 ──
    "H3467", "H3444", "H7965", "H5337",
    # ── 하나님을 아는 지식 ──
    "H0430", "H3068", "H0136", "H3045", "H3372", "H0571", "H3519",
    # ── 지혜문학 ──
    "H2451", "H2450", "H1892",
    # ── 말씀과 사자 ──
    "H1697", "H5030", "H4397", "H8034",
    # ── 목자와 길 ──
    "H7462b", "H6629", "H1870", "H6697", "H4899",
    # ── 영원과 소망 ──
    "H5769", "H8615",
    # ── 신약: 사랑·믿음·소망 ──
    "G0026", "G0025", "G4102", "G4100", "G1680",
    # ── 은혜와 구원 ──
    "G5485", "G4991", "G4982", "G0629",
    # ── 진리와 말씀 ──
    "G0225", "G3056", "G2098",
    # ── 영과 혼, 생명 ──
    "G4151", "G5590", "G2222", "G0166",
    # ── 죄와 회개 ──
    "G0266", "G3341", "G0859",
    # ── 의와 율법 ──
    "G1343", "G3551", "G1344",
    # ── 나라와 영광 ──
    "G0932", "G1391", "G1515",
    # ── 그리스도와 교회 ──
    "G5547", "G2962", "G1577", "G0040", "G4716", "G0386",
    # ── 마음과 제자 ──
    "G2588", "G3101", "G1401",
]


def main():
    idx = {}
    for f in glob.glob(os.path.join(ROOT, "books", "idx", "*.json")):
        idx.update(json.load(open(f, encoding="utf-8")))
    mani = json.load(open(os.path.join(ROOT, "books", "_manifest.json"), encoding="utf-8"))
    lex = json.load(open(os.path.join(ROOT, "books", "_lex.json"), encoding="utf-8"))

    missing, pairs = [], []
    for s in WORDS:
        e = idx.get(s)
        if not e or s not in lex:
            missing.append(s)
            continue
        groups = []
        for p in e["r"].split("|"):
            k = p.index(":")
            bi = int(p[:k])
            refs = p[k + 1:].split(",")
            groups.append((bi, refs))
        groups.sort(key=lambda g: -len(g[1]))
        taken = 0
        for bi, refs in groups:
            if taken >= PER_WORD:
                break
            if len(refs) < MIN_VERSES:
                break
            if taken and len(refs) / float(e["n"]) < MIN_SHARE:
                break
            L = lex[s]
            pairs.append({
                "s": s, "bi": bi, "book": mani[bi]["name"],
                "ko": L.get("ko", ""), "t": L.get("t", ""),
                "n": len(refs), "total": e["n"],
                "def": (L.get("kd") or L.get("d") or L.get("ge") or "")[:300],
                "refs": ",".join(":".join(r.split(".")) for r in refs[:70]),
            })
            taken += 1

    out = io.open(os.path.join(HERE, "_sum_todo.jsonl"), "w", encoding="utf-8")
    for i, p in enumerate(pairs, 1):
        p["i"] = i
        out.write(json.dumps(p, ensure_ascii=False) + "\n")
    out.close()

    print("낱말 %d개 · 조합 %d개" % (len(WORDS) - len(missing), len(pairs)))
    if missing:
        print("색인/사전에 없어 제외: " + ", ".join(missing))


if __name__ == "__main__":
    main()
