const MODEL = "gemini-2.5-flash-lite";
const SYSTEM_PROMPT =
  "당신은 금융 초보자를 돕는 한국어 데이터 해설자입니다. 제공된 계산 결과만 사용해 " +
  "두 문장으로 쉽게 설명하세요. 숫자·기호·목록·마크다운을 출력하지 마세요. " +
  "첫 문장은 왜 평균과 다르게 느끼는지, 둘째 문장은 이 화면에서 사용자가 확인할 " +
  "다음 행동을 말하세요. 종목 추천, 수익 보장, 투자 권유는 금지합니다.";
const CATEGORY_NAMES = Object.freeze({
  food: "식료품·비주류음료",
  alcohol: "주류·담배",
  clothing: "의류·신발",
  housing: "주거·수도·광열",
  household: "가정용품·가사서비스",
  health: "보건",
  transport: "교통",
  comm: "통신",
  leisure: "오락·문화",
  education: "교육",
  dining: "음식·숙박",
  misc: "기타 상품·서비스",
});

const inRange = (value, min, max) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

function validate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const category = CATEGORY_NAMES[body.topCategoryId];
  if (!category ||
      !inRange(body.officialRate, -50, 200) ||
      !inRange(body.personalRate, -50, 200) ||
      !inRange(body.gapPp, -250, 250) ||
      !inRange(body.topSharePct, 0, 100) ||
      !inRange(body.topRatePct, -100, 1000)) return null;
  return {
    officialRate: body.officialRate.toFixed(1),
    personalRate: body.personalRate.toFixed(1),
    gapPp: body.gapPp.toFixed(1),
    category,
    topSharePct: body.topSharePct.toFixed(0),
    topRatePct: body.topRatePct.toFixed(1),
  };
}

function safeText(value, input) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/[*#`]/g, "").slice(0, 500);
  if (!text || /[₩$€]/.test(text)) return null;
  // 모델이 전달받은 값을 반복하는 것은 허용하되, 없던 숫자를 만들면 응답을 버린다.
  const allowed = [
    input.officialRate, input.personalRate, input.gapPp,
    input.topSharePct, input.topRatePct,
  ].map(Number);
  const mentioned = text.match(/-?\d+(?:\.\d+)?/g) || [];
  if (mentioned.some((token) =>
    !allowed.some((number) => Math.abs(Number(token) - number) < 0.051))) return null;
  return text;
}

export async function POST(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 4096) return Response.json({ error: "요청이 너무 큽니다." }, { status: 413 });

  let input;
  try {
    input = validate(await request.json());
  } catch (_error) {
    input = null;
  }
  if (!input) return Response.json({ error: "계산 결과 형식이 올바르지 않습니다." }, { status: 400 });

  // Google AI Studio 키를 쓴다. Vercel AI Gateway는 무료 사용량이 있어도
  // 신용카드가 등록돼 있어야 요청을 처리해 주는데(2026-08-10에 403의 원인으로
  // 확인), 학교 과제에 카드를 걸 이유가 없다. AI Studio는 카드 없이 무료
  // 할당량을 준다.
  //
  // 키는 반드시 서버에서만 읽는다. assets/ 안에 두면 정적 파일이라 그대로
  // 공개된다.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({
      error: "AI 연결이 설정되지 않았습니다.",
      code: "missing-api-key",
    }, { status: 503 });
  }

  const facts = [
    `공식 물가: ${input.officialRate}%`,
    `개인 물가: ${input.personalRate}%`,
    `차이: ${input.gapPp}%p`,
    `가장 큰 영향 품목: ${input.category}`,
    `그 품목의 지출 비중: ${input.topSharePct}%`,
    `그 품목의 물가상승률: ${input.topRatePct}%`,
  ].join("\n");

  try {
    const gatewayResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: facts }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 180 },
        }),
      }
    );
    if (!gatewayResponse.ok) {
      // 게이트웨이가 왜 거부했는지 남긴다. 상태 코드만으로는 키가 틀린 건지,
      // 크레딧이 없는 건지, 모델 권한이 없는 건지 구분할 수 없어서
      // 2026-08-07~10 사이 403 원인을 못 찾고 시간을 썼다.
      // 응답 본문에는 우리 토큰이 들어가지 않으므로 노출해도 안전하다.
      let detail = "";
      try {
        detail = (await gatewayResponse.text()).replace(/\s+/g, " ").slice(0, 200);
      } catch (_ignored) {
        detail = "(본문 없음)";
      }
      console.error(`[insight] gateway ${gatewayResponse.status}: ${detail}`);
      return Response.json({
        error: "AI 해설을 불러오지 못했습니다.",
        code: `gateway-${gatewayResponse.status}`,
        detail,
        authSource: "gemini-api-key",
      }, { status: 502 });
    }
    const output = await gatewayResponse.json();
    const text = safeText(
      output?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(" "),
      input
    );
    if (!text) {
      return Response.json({
        error: "AI 해설을 불러오지 못했습니다.",
        code: "model-output-rejected",
      }, { status: 502 });
    }
    return Response.json({ text, model: MODEL }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (_error) {
    return Response.json({
      error: "AI 해설을 불러오지 못했습니다.",
      code: "gateway-unreachable",
    }, { status: 502 });
  }
}

export function GET() {
  return Response.json({ ok: true, service: "salarygap-ai-insight" });
}
