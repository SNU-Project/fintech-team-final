// 사용할 모델 후보. 앞에서부터 시도하고 404(모델 없음/미제공)면 다음으로 넘어간다.
// 구글이 모델을 수시로 정리해서 하나만 박아 두면 어느 날 조용히 죽는다.
// 지금까지 이 사유로 404가 난 모델: gemini-2.5-flash-lite("no longer
// available to new users"), gemini-2.5-flash(같은 사유), 그리고
// 2026-08-19 프로덕션 로그에서 gemini-2.0-flash도 "no longer available"로
// 확인됐다 — 완전히 빼냈다(맨 앞에 죽은 후보를 두면 모든 요청이 그
// 실패 왕복 한 번을 공짜로 얹고 시작한다). 마지막 후보가 죽어 있으면
// 앞선 후보들이 전부 일시적으로 막힌 순간(503 몇 개가 겹치는 경우) 요청
// 전체가 실패한다 — 실측으로 확인(같은 요청 3번 중 2번 이 경로로 실패).
// 할당량은 모델마다 따로 잡히므로 후보를 여럿 둔다.
// 사고 단계가 없는 모델을 앞에 둬야 짧은 해설이 예측 가능하게 나온다.
const MODELS = [
  "gemini-2.0-flash-lite",
  "gemini-flash-latest",
  "gemini-3.6-flash",
];

// assets/js/app.js의 SPEND_GROUPS 5개 그룹과 반드시 같은 id·이름을
// 유지해야 한다 — 화면이 실제로 보내는 topCategoryId가 이 키와
// 안 맞으면 그 순간부터 매번 400이 난다.
const CATEGORY_NAMES = Object.freeze({
  "g-food": "식비",
  "g-home": "주거·생활",
  "g-move": "교통·통신",
  "g-play": "여가·문화",
  "g-etc": "건강·기타",
});

const inRange = (value, min, max) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

// 리포트 안 4곳(카드3 물가 비교/카드1 처방전/카드3 절약 팁/카드6 시나리오)이
// 이 엔드포인트 하나를 type으로 구분해 쓴다. 새 엔드포인트를 늘리는 대신
// 검증 틀(아래 validate/safeText)을 공유하려고 이렇게 묶었다 — 필드마다
// 허용 범위(range)만 선언하면 safeText가 쓸 "허용된 숫자 목록"도 여기서
// 자동으로 뽑힌다(카테고리·불리언 필드는 숫자가 아니라 자동 제외).
//
// 금지사항을 나열하면 사고형 모델이 그 제약을 곱씹은 내용을 그대로
// 답변으로 뱉는다("기호는 쓰지 마세요 — Does a period count?" 같은 식).
// 그래서 프롬프트마다 하지 말 것 대신 '이렇게 쓰라'는 예시 하나를 준다.
const TYPES = {
  // 카드3 · "공식 물가 vs 내 물가" 비교 (v38에서 처음 연결한 원래 용도)
  "gap-analysis": {
    prompt: [
      "너는 한국어 금융 해설자다. 사용자가 준 수치를 근거로 해설문 두 문장만 쓴다.",
      "다른 말은 절대 덧붙이지 않는다.",
      "",
      "형식 예시:",
      "지출에서 비중이 큰 교통 물가가 크게 올라 평균보다 부담이 크게 느껴집니다. " +
        "아래 기여도 그래프에서 어떤 항목이 영향을 줬는지 확인해 보세요.",
      "",
      "규칙: 첫 문장은 왜 평균과 다르게 느끼는지, 둘째 문장은 화면에서 무엇을 볼지 안내한다.",
      "투자 권유나 수익 보장은 하지 않는다.",
    ].join("\n"),
    fields: {
      officialRate: { range: [-50, 200], label: "공식 물가", unit: "%", digits: 1 },
      personalRate: { range: [-50, 200], label: "개인 물가", unit: "%", digits: 1 },
      gapPp: { range: [-250, 250], label: "차이", unit: "%p", digits: 1 },
      topCategoryId: { category: true, label: "가장 큰 영향 품목" },
      topSharePct: { range: [0, 100], label: "그 품목의 지출 비중", unit: "%", digits: 0 },
      topRatePct: { range: [-100, 1000], label: "그 품목의 물가상승률", unit: "%", digits: 1 },
    },
  },

  // 카드1 · 처방전 결론(#finalBody) 아래에 붙는 한두 문장
  "prescription-note": {
    prompt: [
      "너는 한국어 재정 주치의다. 사용자의 연봉·물가 진단 결과를 근거로,",
      "진료를 마무리하며 건네는 짧은 코멘트 한두 문장만 쓴다. 다른 말은 덧붙이지 않는다.",
      "",
      "형식 예시:",
      "물가 유지선을 여유 있게 넘기고 계시니 지금 페이스를 유지하시면 됩니다. " +
        "다만 오른 품목의 지출은 계속 눈여겨봐 주세요.",
      "",
      "규칙: 화면에 이미 나온 판정(물가를 방어했는지 못했는지)을 다시 설명하지 말고,",
      "그 결과를 요약하는 짧은 코멘트만 쓴다. 특정 투자·상품을 추천하지 않는다.",
    ].join("\n"),
    fields: {
      curSalary: { range: [0, 1000000], label: "현재 연봉", unit: "만원", digits: 0 },
      nextSalary: { range: [0, 1000000], label: "내년 예상 연봉", unit: "만원", digits: 0 },
      requiredSalary: { range: [0, 1000000], label: "물가 유지선(작년과 같은 구매력에 필요한 연봉)", unit: "만원", digits: 0 },
      gapAmount: { range: [-1000000, 1000000], label: "여유·부족분(양수면 여유, 음수면 부족)", unit: "만원", digits: 0 },
      beatsInflation: { bool: true, label: "물가를 방어했는지 여부" },
    },
  },

  // 카드3 · "OO 지출, 이렇게 줄여보세요" 팁 박스 위에 붙는 한 줄
  "saving-tip": {
    prompt: [
      "너는 한국어 재정 주치의다. 사용자가 준 지출 수치를 근거로,",
      "왜 이 항목부터 줄여보면 좋은지 한 문장만 쓴다. 다른 말은 덧붙이지 않는다.",
      "",
      "형식 예시:",
      "지금처럼 교통·통신에 지출 비중이 크다면, 이 항목만 줄여도 체감 물가가 눈에 띄게 낮아질 수 있어요.",
      "",
      "규칙: 절약 방법을 새로 제안하지 않는다 — 방법은 이미 화면에 나열되어 있다.",
      "이 항목에 왜 주목해야 하는지만 준 수치로 설명한다. 투자 권유는 하지 않는다.",
    ].join("\n"),
    fields: {
      topCategoryId: { category: true, label: "절약 대상 품목" },
      topAmount: { range: [0, 1000000], label: "그 품목의 월 지출", unit: "만원", digits: 0 },
      topSharePct: { range: [0, 100], label: "지출 비중", unit: "%", digits: 0 },
      topRatePct: { range: [-100, 1000], label: "그 품목의 물가상승률", unit: "%", digits: 1 },
    },
  },

  // 카드6 · 절감 시나리오 3개 비교 결과 아래에 붙는 한두 문장.
  // 시나리오 이름은 자유 텍스트를 그대로 받지 않고 카테고리 화이트리스트 +
  // 서버가 아는 고정 절감률(10%/5% — assets/js/app.js의 SCENARIO_CUT_PCT와
  // 반드시 같은 값이어야 한다)로 서버에서 직접 조립한다. 자유 텍스트를
  // 받으면 그만큼 별도 검증기를 새로 만들어야 하는데, 절감률 자체가 이미
  // 고정 상수라 그럴 필요가 없다.
  "scenario-summary": {
    prompt: [
      "너는 한국어 재정 주치의다. 절감 시나리오별 결과 수치를 근거로,",
      "어떤 선택이 더 효율적인지 비교하는 한두 문장만 쓴다. 다른 말은 덧붙이지 않는다.",
      "",
      "형식 예시:",
      "두 가지를 함께 줄이면 효과가 가장 크지만, 하나만 시작한다면 비중이 더 큰 쪽이 체감 개선폭이 더 커요.",
      "",
      "규칙: 준 시나리오 수치만 비교하고 새 숫자를 만들지 않는다. 특정 투자는 권하지 않는다.",
    ].join("\n"),
    fields: {
      baselineRate: { range: [-50, 200], label: "지금 내 물가", unit: "%", digits: 2 },
      firstCategoryId: { category: true, label: "① 10% 절감 대상" },
      firstRate: { range: [-50, 200], label: "① 절감 후 내 물가", unit: "%", digits: 2 },
      secondCategoryId: { category: true, label: "② 5% 절감 대상", optional: true },
      secondRate: { range: [-50, 200], label: "② 절감 후 내 물가", unit: "%", digits: 2, optional: true },
      bothRate: { range: [-50, 200], label: "③ 둘 다 절감 후 내 물가", unit: "%", digits: 2, optional: true },
    },
  },
};

function sanitizeField(spec, raw) {
  if (spec.category) return CATEGORY_NAMES[raw] || null;
  if (spec.bool) return typeof raw === "boolean" ? raw : null;
  if (spec.range) {
    if (typeof raw !== "number" || !inRange(raw, spec.range[0], spec.range[1])) return null;
    return raw.toFixed(spec.digits ?? 1);
  }
  return null;
}

function validate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  // type이 없거나 모르는 값이면 기존(v38 이전부터의 유일한 용도) 동작을
  // 그대로 유지한다 — 이미 배포된 화면이 type 없이 부르고 있어도 깨지지 않게.
  const type = typeof body.type === "string" && TYPES[body.type] ? body.type : "gap-analysis";
  const def = TYPES[type];
  const sanitized = { type };
  for (const [key, spec] of Object.entries(def.fields)) {
    if (body[key] === undefined && spec.optional) continue;
    const value = sanitizeField(spec, body[key]);
    if (value === null) return null;
    sanitized[key] = value;
  }
  return sanitized;
}

function buildFacts(sanitized) {
  const def = TYPES[sanitized.type];
  return Object.entries(def.fields)
    .filter(([key]) => sanitized[key] !== undefined)
    .map(([key, spec]) => {
      const value = sanitized[key];
      if (spec.bool) return `${spec.label}: ${value ? "예" : "아니오"}`;
      return `${spec.label}: ${value}${spec.unit || ""}`;
    })
    .join("\n");
}

// 반환: { text } 통과 / { reason, raw } 거부
// 왜 버렸는지 남기지 않으면 model-output-rejected만 보고 원인을 알 수 없다.
function safeText(value, sanitized) {
  if (typeof value !== "string") return { reason: "빈 응답", raw: String(value).slice(0, 120) };
  const text = value.trim().replace(/[*#`]/g, "").slice(0, 500);
  if (!text) return { reason: "빈 문자열", raw: value.slice(0, 120) };
  if (/[₩$€]/.test(text)) return { reason: "통화 기호 포함", raw: text.slice(0, 120) };

  // 모델이 전달받은 값을 반복하는 것은 허용하되, 없던 숫자를 만들면 응답을 버린다.
  // 허용 목록은 이 타입의 range 필드에서만 뽑는다 — 카테고리·불리언은 숫자가
  // 아니므로 애초에 mentioned 정규식에 안 걸린다.
  const def = TYPES[sanitized.type];
  const allowed = Object.entries(def.fields)
    .filter(([key, spec]) => spec.range && sanitized[key] !== undefined)
    .map(([key]) => Number(sanitized[key]));
  const mentioned = text.match(/-?\d+(?:\.\d+)?/g) || [];
  const invented = mentioned.filter((token) =>
    !allowed.some((number) => Math.abs(Number(token) - number) < 0.051));
  if (invented.length) {
    return { reason: `없는 숫자 사용: ${invented.join(", ")}`, raw: text.slice(0, 160) };
  }
  return { text };
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

  const systemPrompt = TYPES[input.type].prompt;
  const facts = buildFacts(input);

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
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: facts }] }],
            // thinkingConfig는 모델마다 지원이 갈려서(안 받는 모델은 400) 쓰지
            // 않는다. 대신 사고와 답변이 함께 들어갈 만큼 여유를 준다.
            // 180 → 답변이 아예 안 나옴, 800 → 두 번째 문장이 잘림.
            // 사고형 모델은 사고에만 수백 토큰을 쓰므로 넉넉히 잡는다.
            generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
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
      console.error(`[insight] ${input.type}/${model} → ${lastStatus}: ${lastDetail}`);
      // 404(그 모델 없음)·429(그 모델 할당량 소진)·503(그 모델이 일시적으로
      // 혼잡 — 배포 후 실측: "currently experiencing high demand... usually
      // temporary")은 다른 모델로 풀릴 수 있으므로 계속 시도한다. 401·403
      // 같은 인증 문제는 모델을 바꿔도 소용없으니 즉시 중단한다.
      if (lastStatus === 404 || lastStatus === 429 || lastStatus === 503) continue;
      break;
    }

    const output = await response.json();
    // 사고형 모델(gemini-flash-latest 등)은 내부 사고를 parts에 함께 담고
    // thought: true 로 표시한다. 이걸 걸러내지 않으면 프롬프트를 곱씹는
    // 내용이 그대로 해설 자리에 나온다.
    const parts = output?.candidates?.[0]?.content?.parts || [];
    const answer = parts
      .filter((part) => !part.thought)
      .map((part) => part.text)
      .filter(Boolean)
      .join(" ");
    const checked = safeText(answer, input);
    if (!checked.text) {
      console.error(`[insight] ${input.type}/${model} 출력 거부: ${checked.reason} | ${checked.raw}`);
      return Response.json({
        error: "AI 해설을 불러오지 못했습니다.",
        code: "model-output-rejected",
        model,
        reason: checked.reason,
        raw: checked.raw,
      }, { status: 502 });
    }
    return Response.json({ text: checked.text, model }, {
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
