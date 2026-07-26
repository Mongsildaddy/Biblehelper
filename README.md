# 엠마오 원어대조성경 (Emmaus)

목회자와 성경을 깊이 읽으려는 성도를 위한 히브리어·헬라어 원어 대조 도구.
개역한글·KJV와 원문(구약 BHS · 신약 SBLGNT)을 절 단위로 나란히 보여 주고,
원어 낱말을 누르면 스트롱번호·품사·뜻과 함께 **성경 전체의 용례**, 그리고
그 낱말이 해당 책 안에서 어떤 의미로 쓰였는지 정리한 **AI 요약**을 볼 수 있습니다.

**https://emmaustransbible.co.kr**
(기존 `mongsildaddy.github.io/Biblehelper` 주소는 이쪽으로 넘어옵니다.)

## 쓰는 법
1. 위쪽에서 **구약 / 신약** 탭을 고르고, 책과 장을 선택합니다.
2. 각 절 아래 원문 줄에서 **원어 낱말을 클릭**합니다.
   (구약 히브리어는 오른쪽부터, 신약 헬라어는 왼쪽부터 읽습니다.)
3. 오른쪽 패널에서 확인할 수 있는 것:
   - 낱말의 음역 · 스트롱번호 · 품사(형태소) · 한국어 뜻
   - 상세 정의 (영문 원본 + 한국어 번역)
   - **성경 내 용례** — 책 이름 버튼을 누르면 그 책의 용례 구절이 펼쳐지고,
     구절을 누르면 바로 그 본문으로 이동합니다.
   - **AI 요약** — 선택한 책 안에서 그 낱말이 지니는 의미를 정리한 글.
     AI가 작성한 참고 자료이며, 박스 하단에 그 사실을 항상 밝혀 둡니다.

## 구조
```
index.html            # 앱 전체 (빌드 없음, 의존성 없음)
books/
  _manifest.json      # 66권 목록·장수·커버리지·결손장
  _lex.json           # 스트롱 렉시콘 (음역·영문뜻·영문정의·한국어gloss·한국어정의)
  _sum.json           # 낱말×책 AI 요약 (미리 생성해 둔 244개)
  idx/*.json          # 스트롱번호 → 용례 위치 색인 (3글자 접두어로 분할)
  Gen.json ... Rev.json   # 책별 데이터 (개역한글·KJV·원문 인터리니어)
server/               # AI 요약 실시간 생성용 Cloudflare Worker (선택)
tools/                # 데이터 생성·병합 스크립트
```

## 실행
정적 파일 fetch를 쓰므로 **웹서버에서 열어야** 합니다 (file:// 직접 열기 불가).
```
python3 -m http.server 8000   # 그 뒤 http://localhost:8000
```
배포는 GitHub Pages · Netlify · Vercel 등 정적 호스팅 아무거나 가능.

## 도메인 연결 (emmaustransbible.co.kr)
도메인 구입 후 아래 순서로 진행합니다. **구입 전에 미리 하면 현재 주소가 끊기니** 주의.

1. 등록기관(가비아·후이즈·카페24 등)에서 `emmaustransbible.co.kr` 등록
2. DNS 레코드 등록
   | 유형 | 호스트 | 값 |
   |---|---|---|
   | A | @ | 185.199.108.153 |
   | A | @ | 185.199.109.153 |
   | A | @ | 185.199.110.153 |
   | A | @ | 185.199.111.153 |
   | CNAME | www | mongsildaddy.github.io. |
3. 저장소 루트에 `CNAME` 파일 생성 — 내용은 `emmaustransbible.co.kr` 한 줄
4. GitHub → Settings → Pages → Custom domain에 도메인 입력 → DNS 검증 통과 후
   **Enforce HTTPS** 체크 (인증서 발급에 최대 24시간)
5. `server/wrangler.toml`의 `ALLOWED_ORIGINS`에 새 도메인 추가 후 Worker 재배포

## 데이터 출처 및 라이선스
- 히브리어 원문·태깅: **OpenScriptures OSHB** / **STEPBible TAHOT** (CC BY 4.0)
- 헬라어 원문·태깅: **STEPBible TAGNT** (SBLGNT 기반, CC BY 4.0)
- 헬라어 상세 정의: **Abbott-Smith, A Manual Greek Lexicon of the NT** (1922, PD)
  — STEPBible **TBESG** 를 통해 수록 (CC BY 4.0)
- 히브리어 상세 정의: **Brown-Driver-Briggs** (1906, PD) + **Strong's Hebrew Dictionary** (1890, PD)
  — [openscriptures/HebrewLexicon](https://github.com/openscriptures/HebrewLexicon) (CC BY 4.0)
  을 통해 수록. 출처 표기: Open Scriptures Hebrew Bible Project
- 개역한글: 2012년 저작권 만료 (공개)
- KJV: 퍼블릭도메인
- 한국어 gloss: 본 프로젝트가 PD 렉시콘을 기반으로 번역 (배치1~5, 감수 전)
- AI 요약(`books/_sum.json`): 본 프로젝트가 Claude로 생성 — 참고 자료, 신학 감수 전

## 현재 상태 (신구약 66권)
- **구약 39권 + 신약 27권 전체 연결.** 원문(히브리어/헬라어)·KJV 전권 완비.
- 신약: 헬라어 원문(TAGNT)·스트롱·형태소 태깅. 헬라어 gloss는 baseline 160개(신약 본문 ~66% 커버), 나머지는 자동화 예정.
- 구약 39권 전체 연결. 히브리어·KJV 전권 완비.
- 한국어 gloss 커버리지 평균 ~70% (자주 쓰이는 단어부터 번역, 롱테일은 진행 중).
- **역대하 21~36장 / 욥기 42장 / 베드로전서 5장**: 무료 개역한글 소스 결손 → 해당 장은 원어·KJV만 표시, 개역한글 "준비 중". 완전한 개역한글 확보 시 보완.
- 요엘·말라기: 히브리어-한글 장 구분 차이(versification) 정렬 완료.

## 완료
- 신약 27권 추가 (TAGNT + TBESG), 신약 원문 좌횡서 표시
- 원어 낱말 → 성경 전체 용례 색인 + 클릭 시 해당 본문으로 이동
- 상세 정의 한국어화 (상위 500개 낱말)
- 낱말×책 AI 요약 244개 내장 + 서버 연결 시 실시간 생성

## 남은 작업
1. 한국어 gloss 롱테일 번역 (배치 API 자동화) → 커버리지 95%+
2. 상세 정의 한국어화 확대 (현재 상위 500개)
3. 역대하 21~36장 · 욥기 42장 · 베드로전서 5장 개역한글 결손 보완
4. AI 요약 조합 확대 (현재 244개) 및 신학 감수
5. 한국어 gloss 신학 감수
6. AdSense 연동 (라이선스 정리 완료 — 아래 참고)

## 라이선스 정리 기록
초기 데이터의 히브리어 상세 정의는 Online Bible이 배포한 **Abridged BDB** 였다.
광고를 붙일 경우 상업적 이용으로 볼 여지가 있는데 이 판본의 재배포 조건이
불분명해, 아래와 같이 정리했다.

- 히브리어 정의를 **BDB 1906 원문 + Strong's 1890** 으로 전량 교체 (9,194개 100%)
  → 두 저작 모두 퍼블릭도메인, 수록 경로인 openscriptures/HebrewLexicon 은 CC BY 4.0
- 옛 정의를 번역했던 한국어 상세정의 361개는 파생물이므로 폐기 후 새 원문 기준 재작성
- **STEPBible TBESH 는 쓰지 않는다.** CC BY 표기와 별개로 파일 헤더에
  "Abridged BDB by Online Bible 기반이므로 적용 전 Online Bible의 허가를 받으라"는
  단서가 붙어 있다.
- 헬라어(TBESG/Abbott-Smith)는 해당 단서가 없고 1922년 간행·저자 1947년 사망으로
  문제 없음 → 그대로 유지
