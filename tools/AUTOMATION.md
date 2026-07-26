# 롱테일 번역 자동화 설계

## 목적
손 배치(1~7)로 전권 커버리지 ~86% 달성 후, 남은 희귀 어휘 ~7,246개를
Anthropic Message Batches API로 한 번에 자동 번역한다.

## 왜 배치 API인가
- **비용 50% 할인**, 요청당 rate limit 걱정 없음, 24시간 내 처리.
- 최대 10만 요청/잡 → 우리 145요청은 여유롭게 1잡.
- 결과는 custom_id로 매칭(순서 보장 안 됨).

## 파이프라인
```
remaining_glosses.json (7,246개, 빈도순)
   │  50개씩 묶어 145 요청 생성 (custom_id=chunk-NNNN)
   ▼
[Batch API 제출]  automate_translation.py --submit
   │  각 요청: 용어집 시스템프롬프트 + gloss목록 → JSON 반환
   ▼
[24h 내 완료]  --collect BATCH_ID
   │  결과 수거 → JSON 파싱 → 자동검증(빈값·영문잔존·아람표기)
   ▼
ko_gloss_merged.json 에 병합  →  rebuild_lex.py 로 books/_lex.json 반영
```

## 실행
```bash
pip install anthropic
export ANTHROPIC_API_KEY=sk-...
cd tools
python automate_translation.py --dry-run          # 요청 생성 확인
python automate_translation.py --submit           # 제출 → BATCH_ID 획득
#  (몇 시간 뒤)
python automate_translation.py --collect BATCH_ID # 수거·검증·병합
python rebuild_lex.py                              # 앱 데이터 반영
```

## 품질 관리 (감수자 없음 대비)
- **용어집 고정**: 배치1~7에서 정한 역어(고유명사·신학용어)를 시스템프롬프트에 내장 → 일관성.
- **자동검증**: 빈값·영문잔존·아람어표기 누락을 기계적으로 필터.
- **출처 노출**: 앱 팝업에 스트롱번호+영문 원뜻을 병기 → 목회자가 원문 대조로 자가 검증 가능.
- **표시**: 자동 번역분은 "기계 번역"으로 표기하고, 추후 감수 시 승격.

## 비용 개략
gloss는 짧아 요청당 입력 ~1~2K 토큰 × 145요청. 배치 할인 적용 시 소액.
정확한 단가는 https://docs.claude.com/en/docs/about-claude/pricing 확인.

## 확장
- 신약(헬라어): TBESG 미번역분을 같은 방식으로. gloss_en/aram 대신 그리스어 처리.
- 상세 정의(정의 산문) 한국어화: 요청당 gloss 수를 줄이고(정의가 길다) 같은 파이프라인 재사용.
