/**
 * 엠마오 원어대조성경 — AI 중계 서버 (Cloudflare Worker)
 *
 * 정적 페이지에서 직접 Claude API를 부르면 API 키가 소스에 노출된다.
 * 이 Worker가 키를 대신 보관하고, 허용된 도메인의 요청만 중계한다.
 *
 * 경로
 *   POST /             낱말×책 AI 요약   (기존)
 *   POST /commentary   장별 주석 번역     (아담 클라크 등 퍼블릭도메인 주석)
 *
 * 필요한 설정 (server/README.md 참고)
 *   시크릿  ANTHROPIC_API_KEY   Anthropic 콘솔에서 발급한 키
 *   변수    ALLOWED_ORIGINS     쉼표로 구분한 허용 도메인
 *   변수    MODEL               (선택) 사용할 모델 이름
 *   KV      SUMCACHE            결과 캐시. 같은 요청은 최초 1회만 과금된다.
 */

/* Workers 의 fetch 는 User-Agent 를 붙이지 않는다. Anthropic 앞단이 그런 요청을
   봇으로 보고 403 forbidden 을 간헐적으로 돌려주므로 명시한다. */
const UA = 'emmaus-bible-worker/1.0 (+https://emmaustransbible.co.kr)';

const MAX_VERSES = 60;
const DEFAULT_MODEL = 'claude-sonnet-5';

/* Anthropic 호출 경로.
   api.anthropic.com 으로 직접 나가면 Cloudflare Workers 의 나가는 IP 일부가
   403 forbidden 으로 막힌다. 차단은 워커 인스턴스에 고정이라, 걸린 인스턴스는
   몇 번을 다시 걸어도 계속 실패한다(실측: 8회 연속 403).
   Cloudflare AI Gateway 를 거치면 이 문제가 사라진다(실측: 24회 연속 200).
   게이트웨이는 무료이고, 사용량 분석과 캐싱도 함께 제공된다.
   ANTHROPIC_URL 변수로 덮어쓸 수 있게 두어, 게이트웨이에 문제가 생기면
   wrangler.toml 만 고쳐 직접 호출로 되돌릴 수 있다. */
const ANTHROPIC_FALLBACK_URL = 'https://api.anthropic.com/v1/messages';

/* 주석 원문 출처. 모두 퍼블릭도메인(CC0)이며 장 단위 JSON으로 제공된다. */
const COMMENTARY_API = 'https://bible.helloao.org/api/c';
const COMMENTARIES = {
  'adam-clarke': '아담 클라크 주석',
  'matthew-henry': '매튜 헨리 주석',
  'jamieson-fausset-brown': '제이미슨-파우셋-브라운 주석',
  'john-gill': '존 길 주석',
  'keil-delitzsch': '카일-델리취 구약주석'
};

/* 기본 주석은 제이미슨-파우셋-브라운(JFB).
   66권 전권을 담고 있어 대체가 일어나지 않고, 같은 장을 클라크·존 길의 약
   절반 분량으로 다룬다(실측 6개 장 합계 440.6KB → 234.5KB, 53%). 번역 비용과
   대기 시간이 그만큼 줄고, 목회자가 읽기에도 군더더기가 적다.
   클라크는 9권이 통째로 빠져 있다(신명기·사사기·시편·잠언·전도서·예레미야·
   요엘·말라기·마태복음). 하필 설교에 가장 많이 쓰이는 책들이다. */
const DEFAULT_COMMENTARY = 'jamieson-fausset-brown';

/* 요청한 주석에 그 장이 없으면 순서대로 시도한다. 어느 주석을 실제로 썼는지는
   응답의 commentary 필드로 돌려주므로 화면에 그대로 밝힌다. */
const FALLBACK = {
  'jamieson-fausset-brown': ['john-gill', 'adam-clarke', 'matthew-henry'],
  'adam-clarke': ['john-gill', 'jamieson-fausset-brown', 'matthew-henry'],
  'matthew-henry': ['john-gill', 'jamieson-fausset-brown'],
  'keil-delitzsch': ['john-gill', 'jamieson-fausset-brown'],
  'john-gill': ['jamieson-fausset-brown']
};

/* 우리 매니페스트의 OSIS 코드 → 주석 API의 3글자 책 코드. 66권 전부. */
const OSIS2API = {
  Gen:'GEN', Exod:'EXO', Lev:'LEV', Num:'NUM', Deut:'DEU', Josh:'JOS', Judg:'JDG',
  Ruth:'RUT', '1Sam':'1SA', '2Sam':'2SA', '1Kgs':'1KI', '2Kgs':'2KI', '1Chr':'1CH',
  '2Chr':'2CH', Ezra:'EZR', Neh:'NEH', Esth:'EST', Job:'JOB', Ps:'PSA', Prov:'PRO',
  Eccl:'ECC', Song:'SNG', Isa:'ISA', Jer:'JER', Lam:'LAM', Ezek:'EZK', Dan:'DAN', Hos:'HOS',
  Joel:'JOL', Amos:'AMO', Obad:'OBA', Jonah:'JON', Mic:'MIC', Nah:'NAM', Hab:'HAB',
  Zeph:'ZEP', Hag:'HAG', Zech:'ZEC', Mal:'MAL', Matt:'MAT', Mark:'MRK', Luke:'LUK',
  John:'JHN', Acts:'ACT', Rom:'ROM', '1Cor':'1CO', '2Cor':'2CO', Gal:'GAL', Eph:'EPH',
  Phil:'PHP', Col:'COL', '1Thess':'1TH', '2Thess':'2TH', '1Tim':'1TI', '2Tim':'2TI',
  Titus:'TIT', Phlm:'PHM', Heb:'HEB', Jas:'JAS', '1Pet':'1PE', '2Pet':'2PE',
  '1John':'1JN', '2John':'2JN', '3John':'3JN', Jude:'JUD', Rev:'REV'
};

/* 한 번에 번역할 원문 길이. 장 전체를 한 요청에 밀어넣으면 응답이 길어져
   타임아웃 위험이 커지므로 나눠서 부르고 이어 붙인다. */
const CHUNK_CHARS = 9000;
const MAX_CHUNKS = 14;          /* 아주 긴 장(로마서 8장 ~102KB)도 덮는다 */
const MAX_GLOSSARY = 220;

/* ── 사용량 제한 ───────────────────────────────────────────────────────
   ALLOWED_ORIGINS 는 Origin 헤더만 본다. 그 헤더는 curl 한 줄이면 위조되므로
   도메인 검사는 실수를 막을 뿐 악용을 막지 못한다. 정적 사이트라 로그인이
   없으니 호출자를 신원으로 가릴 방법도 없다. 남는 방어선은 사용량 상한이다.

   실제로 2026-08 초, 욥기 3~31장·아가 전권·이사야 33개 장이 연속으로 번역된
   기록이 KV에 남았다. 사람이 클릭한 모양이 아니다.

   비용이 드는 것은 '새로 만드는 호출'뿐이다. 캐시에서 나오는 응답은 공짜이므로
   상한을 세지 않는다. 이미 번역된 장을 읽는 데에는 아무 제한이 없다. */
const UNIT_SUMMARY = 1;         /* 낱말 요약 1회 ≈ 출력 900토큰 */
const UNIT_CHUNK = 3;           /* 주석 조각 1개 ≈ 출력 4000토큰 안팎 */
const DAY_UNITS = 120;          /* 사이트 전체 하루 한도 (주석 약 13~40장) */
const IP_UNITS = 36;            /* 한 사람 하루 한도 (주석 약 4~12장) */
const BURST = 30;               /* 60초당 요청 수 (캐시 응답 포함) */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST만 허용됩니다.' }, 405, cors);
    if (!cors['Access-Control-Allow-Origin']) return json({ error: '허용되지 않은 도메인입니다.' }, 403, {});
    if (!env.ANTHROPIC_API_KEY) return json({ error: '서버에 API 키가 설정되지 않았습니다.' }, 500, cors);

    const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

    /* 짧은 시간에 몰아치는 긁기를 먼저 끊는다. KV 일일 한도는 결과적으로
       일관적이라 순간 폭주를 놓칠 수 있는데, 이 바인딩은 그 틈을 메운다. */
    if (env.RL) {
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return json({ error: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.', retryable: true }, 429, cors);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: '잘못된 요청 형식입니다.' }, 400, cors); }

    /* 관리자는 상한을 받지 않는다. 인기 있는 장을 미리 번역해 둘 때 쓴다. */
    const budget = { env, ip, exempt: !!(env.ADMIN_KEY && body.admin === env.ADMIN_KEY) };

    try {
      if (path === '/gloss') return await handleGloss(env, body, cors, budget);
      if (path === '/commentary') return await handleCommentary(env, body, cors, budget);
      return await handleSummary(env, body, cors, budget);
    } catch (e) {
      /* 영구 오류는 502(일시적 장애)가 아니라 409로 돌려준다. 클라이언트가
         상태코드만 보고도 재시도 대상이 아님을 알 수 있다. */
      const st = e.fatal ? 409 : 502;
      return json({ error: String(e.message || e), retryable: !!e.retryable, fatal: !!e.fatal }, st, cors);
    }
  }
};

/* ── 낱말×책 AI 요약 ──────────────────────────────────────────────────── */

async function handleSummary(env, body, cors, budget) {
  const strong = String(body.strong || '').trim();
  const book = String(body.book || '').trim();
  const verses = Array.isArray(body.verses) ? body.verses.slice(0, MAX_VERSES) : [];
  if (!/^[GH]\d{4}[a-z]?$/.test(strong)) return json({ error: '스트롱번호가 올바르지 않습니다.' }, 400, cors);
  if (!book || !verses.length) return json({ error: '요약할 구절이 없습니다.' }, 400, cors);

  const cacheKey = `${strong}|${book}`;
  if (env.SUMCACHE) {
    const hit = await env.SUMCACHE.get(cacheKey);
    if (hit) return json({ summary: hit, cached: true }, 200, cors);
  }

  await charge(budget, UNIT_SUMMARY);
  const summary = await callClaude(env, body, strong, book, verses);
  if (!summary) return json({ error: '요약이 생성되지 않았습니다.' }, 502, cors);

  if (env.SUMCACHE) await env.SUMCACHE.put(cacheKey, summary);
  return json({ summary }, 200, cors);
}

/* ── 낱말 뜻 일괄 번역 (관리자 전용) ──────────────────────────────────────

   _lex.json 의 빈 ko 필드를 채우기 위한 도구용 경로다. 화면에서는 부르지
   않는다. ADMIN_KEY 를 아는 요청만 통과시키는 이유는 두 가지다. 하나는
   상한을 건너뛰기 때문이고, 하나는 이 경로가 임의의 낱말 목록을 받으므로
   열어 두면 번역기로 남용될 수 있기 때문이다.

   결과는 저장소의 tools/koglo/*.json 로 들어가 영구히 남으므로, 같은
   낱말을 두 번 부를 일이 없다. 그래서 KV 캐시를 두지 않는다. */
const MAX_GLOSS_ITEMS = 100;

async function handleGloss(env, body, cors, budget) {
  if (!budget.exempt) return json({ error: '관리자 전용 경로입니다.' }, 403, cors);

  const items = (Array.isArray(body.items) ? body.items : [])
    .slice(0, MAX_GLOSS_ITEMS)
    .filter(it => it && /^[GH]\d{4}[a-z]?$/.test(String(it.s || '')));
  if (!items.length) return json({ error: '낱말 목록이 비어 있습니다.' }, 400, cors);

  const lines = items.map(it => [
    it.s,
    String(it.t || '').slice(0, 40),
    String(it.ge || '').slice(0, 60),
    String(it.d || it.sd || '').replace(/\s+/g, ' ').slice(0, 140)
  ].join(' | ')).join('\n');

  const prompt = `아래는 성경 원어 낱말 목록입니다. 각 줄은 «스트롱번호 | 음역 | 영어 뜻 | 사전 정의»입니다.
각 낱말의 한국어 뜻을 지어 주세요. 원어 대조 성경의 낱말 칩에 한 줄로 들어가는 짧은 뜻입니다.

표기 규칙 (기존 3,500개와 반드시 같은 방식으로 씁니다)
- 아주 짧게 씁니다. 평균 5자, 최대 15자를 넘기지 않습니다.
- 동사는 '나누다', '펴다', '바라다'처럼 '~다'로 끝내는 기본형으로 씁니다.
- 명사는 '길', '왕', '시체'처럼 명사형 그대로 씁니다.
- 형용사는 '참된', '거룩한'처럼 관형형으로 씁니다.
- 뜻이 갈리면 가운뎃점으로 잇습니다: '헛됨·거짓', '코·분노', '펴다·기울이다'.
  최대 3개까지만 적고, 가장 흔한 뜻을 앞에 둡니다.
- 성경 인명·지명은 개역한글 표기를 따릅니다.
- 사전 정의에 Aramaic 이 보이면 뜻 뒤에 '(아람)'을 붙입니다: '그릇(아람)'.
- 숫자는 '예순(60)', '백(100)'처럼 한글과 숫자를 함께 적습니다.
- 한국어 띄어쓰기를 지킵니다: '사망의 그늘', '신접한 자'처럼 씁니다.
  붙여 쓰면 안 됩니다('사망의그늘', '신접한자'는 잘못).
- 한 낱말 안에서 품사를 섞지 않습니다. '품꾼'이면 명사로만, '고용된'이면
  관형형으로만 잇습니다.
- 설명·품사·괄호 주석을 덧붙이지 않습니다. 마크다운을 쓰지 않습니다.
- 뜻을 확정할 수 없으면 영어 뜻을 그대로 직역해서라도 반드시 채웁니다. 빈 값을 두지 않습니다.

출력 형식
JSON 객체 하나만 출력합니다. 키는 스트롱번호, 값은 한국어 뜻입니다.
설명이나 코드펜스 없이 { 로 시작해 } 로 끝나야 합니다.
목록에 있는 ${items.length}개를 하나도 빠뜨리지 마세요.

--- 목록 시작 ---
${lines}
--- 목록 끝 ---`;

  const raw = await anthropic(env, prompt, 8000);
  const obj = parseJsonObject(raw);
  if (!obj) return json({ error: '응답을 해석하지 못했습니다.', raw: raw.slice(0, 300) }, 502, cors);

  /* 요청하지 않은 키가 섞이거나 길이가 튀는 것을 여기서 막는다 */
  const out = {};
  const want = new Set(items.map(it => it.s));
  for (const [k, v] of Object.entries(obj)) {
    if (!want.has(k)) continue;
    const ko = String(v || '').trim().replace(/\s+/g, ' ');
    if (ko && ko.length <= 18) out[k] = ko;
  }
  return json({ glosses: out, asked: items.length, got: Object.keys(out).length }, 200, cors);
}

/* 모델이 코드펜스나 앞뒤 설명을 붙이는 경우가 있어 중괄호만 잘라 낸다. */
function parseJsonObject(raw) {
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    const o = JSON.parse(raw.slice(s, e + 1));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

/* ── 장별 주석 번역 ───────────────────────────────────────────────────── */

async function handleCommentary(env, body, cors, budget) {
  const osis = String(body.osis || '').trim();
  const chapter = parseInt(body.chapter, 10);
  const id = String(body.commentary || DEFAULT_COMMENTARY).trim();
  /* 조각 번호. 긴 장을 한 요청에 다 번역하면 Cloudflare 가 100초쯤에 연결을
     끊는다. 클라이언트가 조각을 하나씩 요청하고, 조각마다 KV에 저장하므로
     실패해도 이미 번역된 조각은 다시 과금되지 않는다. */
  const part = Math.max(1, parseInt(body.part, 10) || 1);

  if (!COMMENTARIES[id]) return json({ error: '알 수 없는 주석입니다.' }, 400, cors);
  const code = OSIS2API[osis];
  if (!code) return json({ error: '이 책은 주석이 제공되지 않습니다.', unavailable: true }, 404, cors);
  if (!(chapter >= 1 && chapter <= 150)) return json({ error: '장 번호가 올바르지 않습니다.' }, 400, cors);

  /* 완성본이 있으면 바로 준다.
     기본 주석을 바꾸기 전에 다른 주석으로 이미 번역해 둔 장이 있으면 그것을
     쓴다. 번역은 한 장에 수천 원이 아니라 수백 원이지만, 이미 지불한 작업을
     버릴 이유가 없고 사용자에게는 기다림 없이 바로 열리는 편이 낫다. */
  const fullKey = `c:${id}:${osis}.${chapter}`;
  if (env.SUMCACHE) {
    for (const cand of [id, ...(FALLBACK[id] || [])]) {
      const hit = await env.SUMCACHE.get(`c:${cand}:${osis}.${chapter}`);
      if (!hit) continue;
      try {
        const d = JSON.parse(hit);
        if (d.text) return json({ ...d, done: true, cached: true }, 200, cors);
      } catch { /* 옛 형식이면 무시하고 다음 후보로 */ }
    }
  }

  /* 원문 확보 (없는 책이면 대체 주석으로) */
  let used = id, blocks = null;
  for (const cand of [id, ...(FALLBACK[id] || [])]) {
    const doc = await fetchCommentary(cand, code, chapter);
    if (!doc) continue;
    const b = flattenCommentary(doc);
    if (b.length) { used = cand; blocks = b; break; }
  }
  if (!blocks) return json({ error: '이 장은 주석이 제공되지 않습니다.', unavailable: true }, 404, cors);

  const chunks = chunkBlocks(blocks, CHUNK_CHARS).slice(0, MAX_CHUNKS);
  const total = chunks.length;
  if (part > total) return json({ error: '조각 번호가 범위를 벗어났습니다.', total }, 400, cors);

  /* 이 조각이 이미 번역돼 있으면 그대로 반환 — 재시도해도 비용이 들지 않는다 */
  const partKey = `${fullKey}#p${part}.${used}`;
  let piece = env.SUMCACHE ? await env.SUMCACHE.get(partKey) : null;
  let pieceCached = !!piece;
  if (!piece) {
    await charge(budget, UNIT_CHUNK);
    piece = await translateChunk(env, {
      text: chunks[part - 1], glossary: buildGlossary(body.glossary),
      ref: `${osis} ${chapter}장`, name: COMMENTARIES[used], part, total
    });
    if (!piece) return json({ error: '번역이 생성되지 않았습니다.' }, 502, cors);
    if (env.SUMCACHE) await env.SUMCACHE.put(partKey, piece);
  }

  /* 마지막 조각까지 모이면 완성본을 저장해 다음부터는 즉시 나온다 */
  let done = false;
  if (env.SUMCACHE && part === total) {
    const all = [piece];
    let ok = true;
    for (let i = 1; i < total; i++) {
      const q = await env.SUMCACHE.get(`${fullKey}#p${i}.${used}`);
      if (!q) { ok = false; break; }
      all[i - 1] = q;
    }
    all[total - 1] = piece;
    if (ok) {
      await env.SUMCACHE.put(fullKey, JSON.stringify({
        text: all.join('\n\n').trim(),
        commentary: COMMENTARIES[used], id: used, substituted: used !== id
      }));
      done = true;
    }
  }

  return json({
    part, total, text: piece, done,
    commentary: COMMENTARIES[used], id: used,
    substituted: used !== id, partCached: pieceCached
  }, 200, cors);
}

/* helloao는 없는 장에도 HTTP 200 + HTML(SPA 폴백)을 돌려준다.
   상태코드만 믿으면 HTML을 JSON으로 파싱하다 죽으므로 본문을 확인한다. */
async function fetchCommentary(id, code, chapter) {
  const res = await fetch(`${COMMENTARY_API}/${id}/${code}/${chapter}.json`);
  if (!res.ok) return null;
  const body = await res.text();
  if (!body.trimStart().startsWith('{')) return null;
  try { return JSON.parse(body); } catch { return null; }
}

/* 주석 JSON은 {chapter:{introduction, content:[{type:'verse',number,content:[...]}]}} 꼴.
   절 번호를 살려 둬야 번역문에서도 어느 절 주석인지 알 수 있다. */
function flattenCommentary(doc) {
  const ch = doc.chapter || {};
  const out = [];
  const intro = String(ch.introduction || doc.introduction || '').trim();
  if (intro) out.push({ label: '서론', text: intro });
  for (const item of ch.content || []) {
    const text = (Array.isArray(item.content) ? item.content : [item.content])
      .map(c => (typeof c === 'string' ? c : (c && c.text) || '')).join('\n').trim();
    if (text) out.push({ label: item.number ? `${item.number}절` : '', text });
  }
  return out;
}

function chunkBlocks(blocks, limit) {
  const chunks = [];
  let cur = '', len = 0;
  for (const b of blocks) {
    const piece = (b.label ? `[${b.label}]\n` : '') + b.text;
    /* 한 절 주석 자체가 한도를 넘으면 그것만 따로 보낸다 */
    if (len && len + piece.length > limit) { chunks.push(cur); cur = ''; len = 0; }
    cur += (cur ? '\n\n' : '') + piece;
    len += piece.length;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function buildGlossary(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const pairs = [];
  for (const [en, ko] of Object.entries(raw)) {
    if (pairs.length >= MAX_GLOSSARY) break;
    const e = String(en).trim(), k = String(ko).trim();
    if (e && k && e.length < 40 && k.length < 40) pairs.push(`${e} = ${k}`);
  }
  return pairs.join('\n');
}

async function translateChunk(env, o) {
  const gloss = o.glossary
    ? `\n\n고유명사·용어 표기 (반드시 이 표기를 그대로 쓰세요)\n${o.glossary}`
    : '';
  const part = o.total > 1 ? `\n(이 장의 ${o.total}부분 중 ${o.part}번째입니다. 앞뒤 인사말 없이 본문만 이어서 옮기세요.)` : '';

  const prompt = `아래는 «${o.name}»의 ${o.ref} 주석 원문(영어)입니다. 한국어로 옮겨 주세요.${part}

번역 지침
- 설교를 준비하는 목회자가 읽습니다. 존댓말로, 학술적이되 읽기 쉽게 옮깁니다.
- 원문의 내용을 빠뜨리거나 요약하지 말고 그대로 옮깁니다. 다만 19세기 영어의
  장황한 문장은 한국어로 자연스럽게 끊어 씁니다.
- 성경 인명·지명은 개역한글 표기를 따릅니다. 아래 용어집이 있으면 그 표기를 우선합니다.
- 히브리어·헬라어 원어가 나오면 원문 그대로 두고, 필요하면 옆에 음역을 괄호로 답니다.
- 성경 구절 인용은 «창세기 1:3» 같은 한국어 책 이름으로 옮깁니다.
- [3절] 같은 절 표시는 그대로 유지합니다.
- 저자가 참조한 라틴어·랍비 문헌 이름은 원어를 남기고 필요하면 짧게 풀이합니다.
- 머리말이나 맺음말, 번역자 주를 덧붙이지 않습니다. 마크다운 기호는 쓰지 않습니다.${gloss}

--- 원문 시작 ---
${o.text}
--- 원문 끝 ---`;

  return await anthropic(env, prompt, 16000);
}

/* ── 공통 ─────────────────────────────────────────────────────────────── */

/* 새로 만드는 호출 직전에만 부른다. 한도를 넘으면 '영구 오류'로 던져서
   클라이언트가 40번 재시도하지 않고 곧바로 사유를 보여 주게 한다.
   KV는 결과적 일관성이라 동시 요청에서 몇 건 새어 나갈 수 있다. 정확한
   회계가 목적이 아니라 폭주를 막는 것이 목적이므로 그 정도는 감수한다. */
async function charge(budget, units) {
  const { env, ip, exempt } = budget;
  if (exempt || !env.SUMCACHE) return;

  const day = new Date().toISOString().slice(0, 10);
  const dayKey = `rl:d:${day}`, ipKey = `rl:i:${day}:${ip}`;
  const [dRaw, iRaw] = await Promise.all([env.SUMCACHE.get(dayKey), env.SUMCACHE.get(ipKey)]);
  const dUsed = Number(dRaw) || 0, iUsed = Number(iRaw) || 0;

  /* 0 은 '새 번역을 전부 잠근다'는 뜻이라 유효한 값이다. || 로 기본값을
     끌어오면 0이 falsy 라 잠금이 풀려 버리므로 빈 값만 기본값으로 본다. */
  const dayMax = num(env.DAY_UNITS, DAY_UNITS);
  const ipMax = num(env.IP_UNITS, IP_UNITS);

  if (dUsed + units > dayMax)
    throw fatalError('오늘 새로 만들 수 있는 분량을 모두 썼습니다. 이미 번역된 장과 낱말 요약은 그대로 보실 수 있고, 새 번역은 내일 다시 열립니다.');
  if (iUsed + units > ipMax)
    throw fatalError('한 분이 하루에 새로 만들 수 있는 분량을 넘었습니다. 이미 번역된 장과 낱말 요약은 계속 보실 수 있습니다. 새 번역은 내일 다시 열립니다.');

  /* 이틀 뒤 자동 삭제 — 카운터가 KV에 쌓이지 않게 한다 */
  await Promise.all([
    env.SUMCACHE.put(dayKey, String(dUsed + units), { expirationTtl: 172800 }),
    env.SUMCACHE.put(ipKey, String(iUsed + units), { expirationTtl: 172800 })
  ]);
}

function corsHeaders(origin, env) {
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = list.includes('*') || list.includes(origin);
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
  if (ok) h['Access-Control-Allow-Origin'] = list.includes('*') ? '*' : origin;
  return h;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

/* Anthropic 앞단이 Cloudflare Workers 의 나가는 IP 일부를 403 forbidden 으로
   막는다. 측정해 보니 차단은 요청별 무작위가 아니라 워커 인스턴스에 고정이다.
   한 요청 안에서 연속 호출하면 3번 다 403이거나 3번 다 200이고, 요청을 새로
   보내면 약 40%가 살아 있는 인스턴스에 걸린다. 따라서 워커 안에서 재시도해도
   같은 IP로 나가 소용이 없고, 클라이언트가 요청 자체를 다시 보내야 한다.
   여기 재시도는 429/5xx 같은 진짜 일시적 오류만 겨냥해 짧게 둔다.
   403 은 재시도하지 않고 즉시 알려, 클라이언트가 다시 걸도록 한다. */
const RETRY_MAX = 3;
const RETRYABLE = new Set([403, 408, 429, 500, 502, 503, 504, 529]);

async function anthropic(env, prompt, maxTokens) {
  let last = '';
  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    if (attempt) await sleep(250 * attempt + Math.floor(Math.random() * 250));
    let res;
    try {
      res = await fetch(env.ANTHROPIC_URL || ANTHROPIC_FALLBACK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': String(env.ANTHROPIC_API_KEY).trim(),
          'anthropic-version': '2023-06-01',
          'User-Agent': UA,
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          model: env.MODEL || DEFAULT_MODEL,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }]
        })
      });
    } catch (e) {
      last = `연결 실패: ${e && e.message || e}`;
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    }
    const raw = (await res.text()).slice(0, 400);
    /* 다시 걸어도 절대 풀리지 않는 오류는 즉시 알린다. 크레딧 소진이나 키 문제를
       재시도하면 사용자는 몇십 초 동안 "시도 중"만 보다가 원인을 못 알게 된다. */
    const fatal = permanent(res.status, raw);
    if (fatal) throw fatalError(fatal);
    last = `${res.status} ${raw.slice(0, 200)}`;
    if (!RETRYABLE.has(res.status)) break;
  }
  if (last.startsWith('403')) {
    const e = new Error('일시적으로 연결이 막혔습니다. 잠시 후 다시 시도해 주세요.');
    e.retryable = true;
    throw e;
  }
  throw new Error(`Anthropic API 호출 실패 ${last}`);
}

/* Anthropic 응답을 보고 '영구 오류'인지 가린다. 돌려주는 문구는 사용자가
   그대로 읽을 것이므로, 무엇이 문제이고 누가 고쳐야 하는지 알 수 있게 쓴다. */
function permanent(status, raw) {
  const t = raw.toLowerCase();
  if (t.includes('credit balance') || t.includes('billing'))
    return '서버의 API 크레딧이 소진되어 새로 만들 수 없습니다. 이미 만들어진 요약과 주석은 그대로 보실 수 있습니다.';
  if (status === 401 || t.includes('authentication_error') || t.includes('invalid x-api-key'))
    return '서버의 API 키에 문제가 있습니다. 관리자 확인이 필요합니다.';
  if (status === 403 && t.includes('permission'))
    return '서버의 API 키에 이 작업 권한이 없습니다. 관리자 확인이 필요합니다.';
  if (status === 404 && t.includes('model'))
    return '설정된 AI 모델을 찾을 수 없습니다. 관리자 확인이 필요합니다.';
  return null;
}

function fatalError(msg) {
  const e = new Error(msg);
  e.retryable = false;
  e.fatal = true;
  return e;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function num(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

async function callClaude(env, body, strong, book, verses) {
  const lines = verses.map(v => `${book} ${v.ref} ${String(v.text || '').slice(0, 200)}`).join('\n');
  const total = Number(body.total) || verses.length;
  const shown = verses.length < total ? `\n(전체 ${total}개 구절 중 ${verses.length}개만 표시)` : '';

  const prompt = `아래는 성경 원어 낱말 하나와, 그 낱말이 «${book}»에서 쓰인 구절 목록입니다.

낱말 정보
- 스트롱번호: ${strong}
- 본문 형태: ${body.lemma || '—'}
- 음역: ${body.translit || '—'}
- 기본 뜻: ${body.gloss || '—'}
- 사전 정의: ${String(body.definition || '—').slice(0, 900)}

«${book}»에서의 용례${shown}
${lines}

위 구절들만 근거로 삼아, 이 낱말이 «${book}»에서 어떤 의미로 쓰이는지 한국어로 요약해 주세요.

작성 지침
- 설교를 준비하는 목회자가 읽는다고 생각하고, 존댓말로 4~6문장 안에 씁니다.
- 이 책 안에서 낱말이 갈라지는 주요 용법을 2~3가지로 구분하고, 각각 근거 구절을 (${book} 1:3) 형식으로 답니다.
- 이 책에서만 두드러지는 특징이 있으면 짚어 줍니다.
- 위에 제시된 구절에서 확인되는 내용만 씁니다. 제시되지 않은 다른 책의 용례나 추측은 넣지 않습니다.
- 교파적 교리 판단은 피하고, 본문에서 관찰되는 쓰임만 기술합니다.
- 머리말이나 맺음말 없이 요약 본문만 출력합니다. 마크다운 기호는 쓰지 않습니다.`;

  return await anthropic(env, prompt, 900);
}
