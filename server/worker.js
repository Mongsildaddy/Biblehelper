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

/* 클라크는 9권이 통째로 빠져 있다(신명기·사사기·시편·잠언·전도서·예레미야·
   요엘·말라기·마태복음). 하필 설교에 가장 많이 쓰이는 책들이라, 없는 책은
   대신 볼 주석을 순서대로 시도한다. 어느 주석을 실제로 썼는지는 응답의
   commentary 필드로 돌려주므로 화면에 그대로 밝힐 수 있다. */
const FALLBACK = {
  'adam-clarke': ['john-gill', 'jamieson-fausset-brown', 'matthew-henry'],
  'matthew-henry': ['john-gill', 'jamieson-fausset-brown'],
  'keil-delitzsch': ['john-gill', 'jamieson-fausset-brown'],
  'jamieson-fausset-brown': ['john-gill'],
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST만 허용됩니다.' }, 405, cors);
    if (!cors['Access-Control-Allow-Origin']) return json({ error: '허용되지 않은 도메인입니다.' }, 403, {});
    if (!env.ANTHROPIC_API_KEY) return json({ error: '서버에 API 키가 설정되지 않았습니다.' }, 500, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: '잘못된 요청 형식입니다.' }, 400, cors); }

    try {
      if (path === '/commentary') return await handleCommentary(env, body, cors);
      return await handleSummary(env, body, cors);
    } catch (e) {
      /* 영구 오류는 502(일시적 장애)가 아니라 409로 돌려준다. 클라이언트가
         상태코드만 보고도 재시도 대상이 아님을 알 수 있다. */
      const st = e.fatal ? 409 : 502;
      return json({ error: String(e.message || e), retryable: !!e.retryable, fatal: !!e.fatal }, st, cors);
    }
  }
};

/* ── 낱말×책 AI 요약 ──────────────────────────────────────────────────── */

async function handleSummary(env, body, cors) {
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

  const summary = await callClaude(env, body, strong, book, verses);
  if (!summary) return json({ error: '요약이 생성되지 않았습니다.' }, 502, cors);

  if (env.SUMCACHE) await env.SUMCACHE.put(cacheKey, summary);
  return json({ summary }, 200, cors);
}

/* ── 장별 주석 번역 ───────────────────────────────────────────────────── */

async function handleCommentary(env, body, cors) {
  const osis = String(body.osis || '').trim();
  const chapter = parseInt(body.chapter, 10);
  const id = String(body.commentary || 'adam-clarke').trim();
  /* 조각 번호. 긴 장을 한 요청에 다 번역하면 Cloudflare 가 100초쯤에 연결을
     끊는다. 클라이언트가 조각을 하나씩 요청하고, 조각마다 KV에 저장하므로
     실패해도 이미 번역된 조각은 다시 과금되지 않는다. */
  const part = Math.max(1, parseInt(body.part, 10) || 1);

  if (!COMMENTARIES[id]) return json({ error: '알 수 없는 주석입니다.' }, 400, cors);
  const code = OSIS2API[osis];
  if (!code) return json({ error: '이 책은 주석이 제공되지 않습니다.', unavailable: true }, 404, cors);
  if (!(chapter >= 1 && chapter <= 150)) return json({ error: '장 번호가 올바르지 않습니다.' }, 400, cors);

  /* 완성본이 있으면 바로 준다 */
  const fullKey = `c:${id}:${osis}.${chapter}`;
  if (env.SUMCACHE) {
    const hit = await env.SUMCACHE.get(fullKey);
    if (hit) {
      try { const d = JSON.parse(hit); if (d.text) return json({ ...d, done: true, cached: true }, 200, cors); }
      catch { /* 옛 형식이면 무시하고 새로 만든다 */ }
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
