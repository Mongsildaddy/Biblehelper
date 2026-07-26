# AI 요약 서버 (Cloudflare Worker)

단어 패널의 **AI 요약 박스**를 실시간으로 채워 주는 작은 중계 서버입니다.

## 왜 서버가 필요한가

미크라는 GitHub Pages에서 도는 정적 페이지라 서버가 없습니다. 그래서 페이지가 직접
Claude API를 부르려면 API 키를 HTML 안에 적어야 하는데, 소스가 그대로 공개되어 있으니
누구나 키를 꺼내 쓸 수 있습니다. 이 Worker가 키를 대신 들고 있으면서 허용된 도메인의
요청만 중계합니다.

서버를 붙이지 않아도 서비스는 정상 동작합니다. 그 경우 `books/_sum.json`에 미리 넣어 둔
요약만 보이고, 생성 버튼은 나타나지 않습니다.

## 준비물

- Cloudflare 계정 (무료 등급으로 충분합니다)
- Anthropic API 키 — <https://console.anthropic.com> 에서 발급
- Node.js 18 이상

> API 키는 절대 저장소에 커밋하지 마세요. 아래 3단계처럼 `wrangler secret`으로만 넣습니다.

## 배포 절차

### 1. wrangler 로그인

```bash
cd server
npx wrangler login
```

브라우저가 열리면 Cloudflare 계정으로 승인합니다.

### 2. 허용 도메인 확인

`wrangler.toml`의 `ALLOWED_ORIGINS`에 실제 서비스 주소가 들어 있는지 봅니다.
나중에 개인 도메인을 붙이면 여기에도 추가해야 합니다.

```toml
ALLOWED_ORIGINS = "https://mongsildaddy.github.io,https://내도메인.kr"
```

### 3. API 키 등록

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

프롬프트가 뜨면 발급받은 키를 붙여 넣습니다. 이 값은 Cloudflare에만 저장되고
`wrangler.toml`이나 저장소에는 남지 않습니다.

### 4. (선택) 캐시 붙이기

같은 단어·같은 책 요약을 여러 사람이 눌러도 한 번만 과금되게 하려면 KV를 붙입니다.

```bash
npx wrangler kv namespace create SUMCACHE
```

출력된 `id`를 `wrangler.toml`의 `[[kv_namespaces]]` 블록에 채우고 주석을 풉니다.

### 5. 배포

```bash
npx wrangler deploy
```

`https://miqra-sum.<계정이름>.workers.dev` 같은 주소가 출력됩니다.

### 6. 페이지에 주소 연결

저장소 루트의 `index.html`에서 `SUMAPI`를 찾아 4단계에서 받은 주소를 넣습니다.

```js
const SUMAPI='https://miqra-sum.내계정.workers.dev';
```

커밋해서 푸시하면, 요약이 없는 단어·책 조합에 **«AI 요약 생성하기»** 버튼이 나타납니다.

> 커밋하기 전에 먼저 시험해 보고 싶다면, 사이트를 연 상태에서 개발자 도구 콘솔에
> 아래를 붙여 넣으면 그 브라우저에서만 켜집니다.
>
> ```js
> localStorage.setItem('miqra.sumapi', 'https://miqra-sum.내계정.workers.dev');
> location.reload();
> ```
>
> 끌 때는 `localStorage.removeItem('miqra.sumapi')` 후 새로고침합니다.

## 동작 방식

1. 사용자가 단어를 누르고 책 이름 칩을 고릅니다.
2. `books/_sum.json`에 해당 조합의 요약이 있으면 그대로 보여 줍니다. (서버 호출 없음)
3. 없으면 브라우저 `localStorage`에 저장된 이전 결과를 찾습니다.
4. 그래도 없고 `SUMAPI`가 설정돼 있으면 생성 버튼이 뜹니다. 누르면 그 책의 구절
   최대 60개를 Worker로 보내고, Worker가 Claude에게 요약을 받아 돌려줍니다.
5. 받은 요약은 브라우저에 저장되어 다음부터는 즉시 표시됩니다.

## 비용을 아끼려면

- **4단계 KV 캐시를 꼭 붙이세요.** 같은 조합은 최초 1회만 과금됩니다.
- 자주 쓰이는 조합은 `tools/kodef` 방식처럼 미리 만들어 `books/_sum.json`에 넣어 두면
  아예 호출이 일어나지 않습니다.
- `worker.js`의 `MAX_VERSES`(기본 60)를 줄이면 요청당 토큰이 줄어듭니다.

## 문제가 생기면

| 증상 | 확인할 것 |
| --- | --- |
| `허용되지 않은 도메인입니다` | `ALLOWED_ORIGINS`에 현재 접속 주소가 있는지 |
| `서버에 API 키가 설정되지 않았습니다` | 3단계 `wrangler secret put`을 했는지 |
| `Anthropic API 401` | 키가 유효한지, 콘솔에서 폐기되지 않았는지 |
| `Anthropic API 404` | `MODEL` 이름이 현재 제공되는 모델인지 (Anthropic 문서의 모델 목록 확인) |
| 버튼이 아예 안 보임 | `index.html`의 `SUMAPI`가 비어 있는지 |
