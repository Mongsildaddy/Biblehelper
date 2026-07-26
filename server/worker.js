/**
 * 미크라 — AI 요약 프록시 (Cloudflare Worker)
 *
 * 정적 페이지에서 직접 Claude API를 부르면 API 키가 소스에 노출된다.
 * 이 Worker가 키를 대신 보관하고, 허용된 도메인의 요청만 중계한다.
 *
 * 필요한 설정 (server/README.md 참고)
 *   시크릿  ANTHROPIC_API_KEY   Anthropic 콘솔에서 발급한 키
 *   변수    ALLOWED_ORIGINS     쉼표로 구분한 허용 도메인
 *   변수    MODEL               (선택) 사용할 모델 이름
 *   KV      SUMCACHE            (선택) 결과 캐시. 붙이면 같은 요청은 과금되지 않는다.
 */

const MAX_VERSES = 60;
const DEFAULT_MODEL = 'claude-sonnet-4-5';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST만 허용됩니다.' }, 405, cors);
    if (!cors['Access-Control-Allow-Origin']) return json({ error: '허용되지 않은 도메인입니다.' }, 403, {});
    if (!env.ANTHROPIC_API_KEY) return json({ error: '서버에 API 키가 설정되지 않았습니다.' }, 500, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: '잘못된 요청 형식입니다.' }, 400, cors); }

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

    let summary;
    try {
      summary = await callClaude(env, body, strong, book, verses);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, cors);
    }
    if (!summary) return json({ error: '요약이 생성되지 않았습니다.' }, 502, cors);

    if (env.SUMCACHE) await env.SUMCACHE.put(cacheKey, summary);
    return json({ summary }, 200, cors);
  }
};

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

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: env.MODEL || DEFAULT_MODEL,
      max_tokens: 900,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic API ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
}
