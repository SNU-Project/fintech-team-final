// 사용할 모델 후보. 앞에서부터 시도하고 404(모델 없음/미제공)면 다음으로 넘어간다.
// 구글이 모델을 수시로 정리해서 하나만 박아 두면 어느 날 조용히 죽는다.
// 실제로 gemini-2.5-flash-lite가 "no longer available to new users"로 404가 났다.
const MODELS = [
  "gemini-2.0-flash",       // 사고 단계가 없어 짧은 해설에 가장 예측 가능하다
  "gemini-flash-latest",
  "gemini-2.5-flash",
];
const SYSTEM_PROMPT =
  "당신은 금융 초보자를 돕는 한국어 데이터 해설자입니다. " +
  "사용자가 준 계산 결과만 근거로, 해설문 두 문장만 그대로 출력하세요. " +
  "설명·머리말·따옴표·마크다운·목록·숫자·기호는 쓰지 마세요. " +
  "첫 문장은 왜 평균과 다르게 느끼는지, 둘째 문장은 이 화면에서 무엇을 확인하면 " +
  "좋을지 말하세요. 종목 추천, 수익 보장, 투자 권유는 하지 마세요.";
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

  // 모델을 앞에서부터 시도한다. 404(그 모델이 없거나 내 계정에 안 열림)면
  // 다음 후보로 넘어가고, 그 외 오류는 바로 반환한다.
  let lastStatus = 0;
  let lastDetail = "";

  for (const model of MODELS) {
    let response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: facts }] }],
            // thinkingConfig는 모델마다 지원이 갈려서(안 받는 모델은 400) 쓰지
            // 않는다. 대신 사고와 답변이 함께 들어갈 만큼 여유를 준다.
            // 180으로 뒀을 때는 사고가 다 먹고 답변이 잘려
            // "Exactly two sentences (두 문장)." 같은 쓰레기가 나왔다.
            generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
          }),
        }
      );
    } catch (_error) {
      return Response.json({
        error: "AI 해설을 불러오지 못했습니다.",
        code: "gateway-unreachable",
      }, { status: 502 });
    }

    if (!response.ok) {
      // 상태 코드만으로는 키가 틀린 건지, 모델이 없는 건지, 할당량이 떨어진
      // 건지 구분할 수 없다. 응답 본문을 남겨야 원인을 짚을 수 있다.
      // (응답에 우리 키는 들어가지 않으므로 노출해도 안전하다)
      lastStatus = response.status;
      try {
        lastDetail = (await response.text()).replace(/\s+/g, " ").slice(0, 200);
      } catch (_ignored) {
        lastDetail = "(본문 없음)";
      }
      console.error(`[insight] ${model} → ${lastStatus}: ${lastDetail}`);
      if (lastStatus === 404) continue;   // 이 모델만 없는 경우 → 다음 후보
      break;                              // 인증·할당량 문제 → 더 시도해도 소용없다
    }

    const output = await response.json();
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
    return Response.json({ text, model }, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  return Response.json({
    error: "AI 해설을 불러오지 못했습니다.",
    code: `gateway-${lastStatus || "unknown"}`,
    detail: lastDetail,
    authSource: "gemini-api-key",
  }, { status: 502 });
}

export function GET() {
  return Response.json({ ok: true, service: "salarygap-ai-insight" });
}
