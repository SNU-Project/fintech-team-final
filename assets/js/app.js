/* ============================================================
   화면 조립 — 데이터 로드, 입력 바인딩, 렌더링
   ============================================================ */
(function () {
  "use strict";

  // 브라우저는 새로고침 시 직전 스크롤 위치를 자기가 알아서 복원하려
  // 한다("auto"). 이 사이트는 새로고침하면 항상 맨 위(요약 화면)에서
  // 시작해야 하는데, 이 복원이 우리 JS의 scrollHomeToTop보다 늦게(또는
  // 겹쳐서) 적용되면 둘이 경합해서 애매한 위치에 멈춘다. 가장 먼저
  // "manual"로 꺼서 스크롤 위치는 전부 우리 코드가 정하게 한다.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const { barChart, hBarChart, lineChart } = window.Charts;
  const E = window.Engine;

  // 품목명이 데이터에서 오기 때문에 조사를 고정할 수 없다.
  // 마지막 글자의 받침 유무로 골라 준다. ("식료품…음료이" 같은 문장 방지)
  function josa(word, withBatchim, withoutBatchim) {
    const last = (word || "").trim().slice(-1);
    const code = last.charCodeAt(0);
    if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return withoutBatchim;
    return (code - 0xac00) % 28 ? withBatchim : withoutBatchim;
  }

  const man = (n) => Math.round(n).toLocaleString("ko-KR");
  const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;
  const signPct = (n, d = 1) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;

  // 화면에 보이는 두 값(예: 공식 물가 2.8%, 내 물가 2.8%)이 반올림 후
  // 같아 보이는데, 그 차이는 원본 정밀 값끼리 뺀 뒤 따로 반올림해서
  // "+0.1%p"처럼 어긋나 보이는 문제를 막는다. 화면에 실제로 찍히는
  // 자리수로 두 값을 각각 반올림한 뒤에 빼서, 같아 보이면 차이도 항상
  // 정확히 0이 되게 한다. 표시 전용 헬퍼다 — 협상 가이드의 목표 금액처럼
  // 그 자체가 다른 계산에 쓰이는 값은 원본 정밀도를 그대로 두고, 화면에
  // "차이"로 보여주는 문구를 만들 때만 이 함수를 쓴다.
  const displayDiff = (a, b, digits = 0) => Number(a.toFixed(digits)) - Number(b.toFixed(digits));

  // v34: 진찰(설문)/진단(리포트 카드1~4)/처방(카드5~6·목표 자산·
  // 자산 타임머신) 3단계에 따라 사이트 메인 컬러를 바꾼다. 진단은
  // body에 별도 클래스 없이 :root 기본값(블루)을 그대로 쓰고,
  // 진찰·처방만 클래스를 얹어 styles.css의 토큰 재정의 블록
  // (.stage-checkup/.stage-prescription)이 --brand 등을 갈아입힌다.
  // #stageTracker의 활성 pill도 여기서 같이 옮긴다.
  let currentStage = null;
  function setStage(stage) {
    if (stage === currentStage) return;
    currentStage = stage;
    document.body.classList.remove("stage-checkup", "stage-prescription");
    if (stage === "checkup" || stage === "prescription") {
      document.body.classList.add(`stage-${stage}`);
    }
    $$(".stage-pill").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.stage === stage);
    });
  }

  const ASSET_COLOR = {
    cash: "var(--series-1)", bond10y: "var(--series-3)", kodex200: "var(--series-2)",
    sp500: "var(--series-4)", gold: "var(--series-5)", bitcoin: "var(--series-6)",
  };
  const colorOf = (id) => ASSET_COLOR[id] || "var(--text-muted)";

  const PERSONA_DATA = window.Personas;
  const PERSONAS = PERSONA_DATA.profiles;
  const DEFAULT_PERSONA = "solo";

  // 12개 COICOP 실카테고리(물가 계산용, 손대지 않음)를 사람이 보기 편한
  // 5개 그룹으로 묶어서 입력 UI에만 쓴다. id는 g- 접두사로 실카테고리
  // id와 절대 안 겹치게 한다. 12개 전부 정확히 한 그룹에만 속한다.
  const SPEND_GROUPS = [
    { id: "g-food", name: "식비", hint: "장보기, 외식, 배달, 카페",
      examples: "쌀·채소·고기·과일, 우유·커피, 식당 밥값, 배달비, 술집 제외",
      members: ["food", "dining"] },
    { id: "g-home", name: "주거·생활", hint: "월세, 관리비, 공과금, 생활용품",
      examples: "월세·전세이자, 관리비, 전기·가스·수도요금, 세제·휴지, 가구·가전",
      members: ["housing", "household"] },
    { id: "g-move", name: "교통·통신", hint: "대중교통, 기름값, 휴대폰·인터넷",
      examples: "버스·지하철·택시비, 기름값(유가), 자동차 구입·수리·보험, 휴대폰 요금, 인터넷",
      members: ["transport", "comm"] },
    { id: "g-play", name: "여가·문화", hint: "여행, 취미, 옷, 교육",
      examples: "여행·숙박, 영화·공연, 넷플릭스 등 구독료, 옷·신발, 학원비·등록금",
      members: ["leisure", "education", "clothing"] },
    { id: "g-etc", name: "건강·기타", hint: "병원비, 술·담배, 보험 등",
      examples: "병원 진료비·약값, 건강보조식품, 술·담배, 미용실, 보험료", members: ["health", "alcohol", "misc"] },
  ];
  const SPEND_GROUP_COLOR = {
    "g-food": "var(--series-1)", "g-home": "var(--series-2)", "g-move": "var(--series-3)",
    "g-play": "var(--series-4)", "g-etc": "var(--series-5)",
  };

  // v47: v46(숫자 직접 입력하는 "자세히 입력하기" 아코디언)을 걷어내고
  // 구간 버튼 퀴즈로 바꾼다 — 계산 원리는 v46과 동일(freq×avg×multiplier,
  // 또는 direct는 이미 월 총액)하고, 숫자 입력 대신 버튼을 고르면 그
  // 버튼의 대표값(구간 중간값)이 freq/avg 자리에 들어간다. category별로
  // 합산해 만원으로 반올림한 뒤 draft.spending에 직접 써 넣는 방식,
  // "이 그룹 키가 없으면 총액 직접입력 그대로"인 하위호환도 v46과 같다.
  // 카테고리별로 순차 적용 중(식비 먼저) — 아직 없는 그룹은 화면에서도
  // 총액 입력 칸만 보여준다(index.html의 플레이스홀더 스텝).
  const SPEND_GROUP_DETAILS = {
    "g-food": {
      fields: [
        { id: "dining", category: "dining", mode: "freq-avg", multiplier: 4.3, label: "배달/외식",
          freqOptions: [
            { value: 0.5, label: "거의 안 함", hint: "주 0~1회" },
            { value: 2.5, label: "가끔", hint: "주 2~3회" },
            { value: 5, label: "자주", hint: "주 4~6회" },
            { value: 7, label: "매일", hint: "주 7회" },
          ],
          avgOptions: [
            { value: 5000, label: "1만원 미만" },
            { value: 15000, label: "1~2만원" },
            { value: 25000, label: "2~3만원" },
            { value: 35000, label: "3만원 이상" },
          ] },
        // v53: 이 필드의 마지막 구간이 "주 2회 이상"으로 되어 있어 앞의
        // 세 버튼(월 단위)과 단위가 섞여 있었다 — 같은 값(8)을 그대로
        // 두고 표기만 shopping/gathering이 이미 쓰는 "월 6회 이상"
        // 관례에 맞췄다(세 필드 모두 multiplier:1, 같은 대표값 체계).
        { id: "grocery", category: "food", mode: "freq-avg", multiplier: 1, label: "장보기", noZeroOption: true,
          freqOptions: [
            { value: 0.5, label: "거의 안 함", hint: "월 0~1회" },
            { value: 1.5, label: "월 1~2회" },
            { value: 4, label: "월 3~5회" },
            { value: 8, label: "월 6회 이상" },
          ],
          avgOptions: [
            { value: 15000, label: "3만원 미만" },
            { value: 50000, label: "3~7만원" },
            { value: 110000, label: "7~15만원" },
            { value: 200000, label: "15만원 이상" },
          ] },
        { id: "cafe", category: "dining", mode: "freq-avg", multiplier: 4.3, label: "카페/음료", noZeroOption: true,
          freqOptions: [
            { value: 0.5, label: "거의 안 함", hint: "주 0~1회" },
            { value: 1.5, label: "주 1~2회" },
            { value: 3.5, label: "주 3~4회" },
            { value: 6, label: "거의 매일", hint: "주 5회 이상" },
          ],
          avgOptions: [
            { value: 3000, label: "5천원 미만" },
            { value: 7500, label: "5천~1만원" },
            { value: 15000, label: "1~2만원" },
            { value: 25000, label: "2만원 이상" },
          ] },
      ],
    },
    // v46에서 이미 확인한 매핑 그대로: 주거 고정비+공과금 → housing,
    // 생활용품/구독 → household(같은 category를 여러 필드가 가리키면
    // 자동 합산된다). direct 모드는 amtOptions 하나짜리 질문이다.
    "g-home": {
      fields: [
        { id: "housing-fixed", category: "housing", mode: "direct", label: "주거 고정비", hint: "월세 및 관리비 합계",
          amtOptions: [
            { value: 300000, label: "50만원 미만" },
            { value: 650000, label: "50~80만원" },
            { value: 1000000, label: "80~120만원" },
            { value: 1500000, label: "120만원 이상" },
          ] },
        { id: "utility", category: "housing", mode: "direct", label: "공과금", hint: "월평균 전기·가스·수도 요금",
          amtOptions: [
            { value: 30000, label: "5만원 미만" },
            { value: 75000, label: "5~10만원" },
            { value: 125000, label: "10~15만원" },
            { value: 200000, label: "15만원 이상" },
          ] },
        { id: "household", category: "household", mode: "direct", label: "생활용품/구독", hint: "월 소모품 구매액 및 정기 구독료 합계",
          amtOptions: [
            { value: 15000, label: "3만원 미만" },
            { value: 50000, label: "3~7만원" },
            { value: 110000, label: "7~15만원" },
            { value: 200000, label: "15만원 이상" },
          ] },
      ],
    },
    "g-move": {
      fields: [
        { id: "commute-mode", category: null, mode: "select", label: "주 이용 수단",
          options: [
            { value: "transit", label: "대중교통" },
            { value: "car", label: "자차" },
            { value: "walk", label: "도보/자전거" },
            { value: "mixed", label: "혼합" },
          ] },
        { id: "commute-cost", category: "transport", mode: "direct", label: "이동 비용", hint: "기름값, 교통카드 등 월 총 지출액",
          amtOptions: [
            { value: 30000, label: "5만원 미만" },
            { value: 100000, label: "5~15만원" },
            { value: 225000, label: "15~30만원" },
            { value: 400000, label: "30만원 이상" },
          ] },
        { id: "phone-cost", category: "comm", mode: "direct", label: "통신비", hint: "월 휴대폰 요금",
          amtOptions: [
            { value: 20000, label: "3만원 미만" },
            { value: 40000, label: "3~5만원" },
            { value: 65000, label: "5~8만원" },
            { value: 100000, label: "8만원 이상" },
          ] },
        { id: "phone-plan", category: null, mode: "select", label: "알뜰폰 사용 여부",
          options: [
            { value: "yes", label: "예" },
            { value: "no", label: "아니오" },
          ] },
      ],
    },
    // g-play는 실카테고리 3개(leisure/education/clothing)인데 요청서
    // 세부질문은 education(학원비·등록금)을 안 다룬다 — v46과 같은
    // 이유로 억지로 만들지 않는다. education은 이 퀴즈가 안 건드리므로
    // 이전 값(페르소나 기본값 등)을 그대로 유지한 채 총액에 계속
    // 더해진다.
    "g-play": {
      fields: [
        { id: "shopping", category: "clothing", mode: "freq-avg", multiplier: 1, label: "쇼핑(패션/뷰티)", noZeroOption: true,
          freqOptions: [
            { value: 0.5, label: "거의 안 함", hint: "월 0~1회" },
            { value: 1.5, label: "월 1~2회" },
            { value: 4, label: "월 3~5회" },
            { value: 8, label: "월 6회 이상" },
          ],
          avgOptions: [
            { value: 15000, label: "3만원 미만" },
            { value: 50000, label: "3~7만원" },
            { value: 110000, label: "7~15만원" },
            { value: 200000, label: "15만원 이상" },
          ] },
        { id: "hobby", category: "leisure", mode: "direct", label: "취미/구독", hint: "헬스장, OTT, 클래스 등 월 정기 지출액 합계",
          amtOptions: [
            { value: 15000, label: "3만원 미만" },
            { value: 65000, label: "3~10만원" },
            { value: 150000, label: "10~20만원" },
            { value: 300000, label: "20만원 이상" },
          ] },
        // hobby와 같은 category(leisure)로 모인다 — divisor:12로 연간
        // 예산을 월 환산.
        { id: "travel", category: "leisure", mode: "direct", divisor: 12, label: "여행/휴식", hint: "연간 여행 예산",
          amtOptions: [
            { value: 300000, label: "50만원 미만" },
            { value: 1000000, label: "50~150만원" },
            { value: 2250000, label: "150~300만원" },
            { value: 4000000, label: "300만원 이상" },
          ] },
      ],
    },
    // g-etc는 실카테고리 3개(health/alcohol/misc)와 요청서 세부질문
    // 3개가 정확히 1:1로 맞아떨어지는 유일한 그룹이다(v46에서 확인한
    // 매핑 그대로) — 보험료는 CPI상 "건강"이 아니라 기타 상품·서비스에
    // 가까워 misc로, 모임/술자리는 술 문화와 직결돼 alcohol로, "담배·
    // 반려동물·정기 병원비"를 묶은 기타 정기 지출은 그중 CPI 매칭이
    // 가장 분명한 정기 병원비를 기준으로 health로 보냈다.
    "g-etc": {
      fields: [
        { id: "insurance", category: "misc", mode: "direct", label: "보험료", hint: "월 납입 총액",
          amtOptions: [
            { value: 30000, label: "5만원 미만" },
            { value: 100000, label: "5~15만원" },
            { value: 225000, label: "15~30만원" },
            { value: 400000, label: "30만원 이상" },
          ] },
        { id: "gathering", category: "alcohol", mode: "freq-avg", multiplier: 1, label: "모임/술자리", noZeroOption: true,
          freqOptions: [
            { value: 0.5, label: "거의 안 함", hint: "월 0~1회" },
            { value: 1.5, label: "월 1~2회" },
            { value: 4, label: "월 3~5회" },
            { value: 8, label: "월 6회 이상" },
          ],
          avgOptions: [
            { value: 10000, label: "2만원 미만" },
            { value: 30000, label: "2~4만원" },
            { value: 55000, label: "4~7만원" },
            { value: 90000, label: "7만원 이상" },
          ] },
        { id: "misc-regular", category: "health", mode: "direct", label: "기타 정기 지출", hint: "담배, 반려동물, 정기 병원비 등 월 총액 합계",
          amtOptions: [
            { value: 0, label: "없음" },
            { value: 15000, label: "3만원 미만" },
            { value: 65000, label: "3~10만원" },
            { value: 150000, label: "10만원 이상" },
          ] },
      ],
    },
  };

  // 카테고리별 절약 팁 — 카드3("범인")·시나리오 계산(카드7)·격차 추이
  // 카드(항목 5·7)가 전부 이 하나의 데이터를 공유한다. 문구에는 "월
  // OO원 절약" 같은 구체 금액을 넣지 않는다 — 사람마다 실제 절감액이
  // 다른데 하나의 숫자로 단정하면 그 자체가 지어낸 값이 된다. 대신
  // 실제 계산이 필요한 "그래서 얼마나 좋아지나"는 시나리오 계산
  // (buildSpendScenario)이 사용자의 진짜 지출로 다시 계산해 답한다.
  const SPEND_TIPS = {
    "g-move": [
      "알뜰 요금제로 바꾸면 통신비 부담을 크게 줄일 수 있어요.",
      "대중교통 정기권이나 환승 할인을 챙기면 교통비가 줄어요.",
    ],
    "g-food": [
      "배달 대신 집밥 비중을 늘리면 식비가 눈에 띄게 줄어요.",
      "장보기 주기를 조정하면 식재료 낭비를 줄일 수 있어요.",
    ],
    "g-home": [
      "관리비 고지서에서 절감 가능한 항목을 점검해보세요.",
      "생활용품은 정기배송·구독 서비스 가격을 비교해보세요.",
    ],
    "g-play": [
      "안 쓰는 구독 서비스를 정리해보세요.",
      "시즌 할인이나 멤버십 혜택을 챙겨보세요.",
    ],
    "g-etc": [
      "보험 등 정기 지출을 한 번씩 재점검해보세요.",
      "약국보다 저렴한 상비약 코너나 온라인몰을 비교해보세요.",
    ],
  };

  // v48: AI 해설을 걷어내면서(v48-B1), 그 자리를 v47에서 실제로 답한
  // 세부 응답(빈도·금액 구간)으로 채운다. 위 SPEND_TIPS 주석의 원칙
  // ("절감액을 지어내지 않는다")은 그대로 지킨다 — 다만 v47 응답은
  // 사용자가 직접 고른 구간의 대표값이라, 그 값에서 나온 계산은
  // "지어낸 평균"이 아니라 시나리오 계산과 같은 종류의 실제 계산이다.
  // 그래서 세부 응답이 있는 필드에 한해서만 구체적인 금액을 말하고,
  // 총액만 직접 입력한 사용자(세부 응답 없음)에게는 기존처럼 숫자
  // 없는 SPEND_TIPS만 보여준다.
  function optionLabelFor(options, value) {
    const opt = options?.find((o) => o.value === value);
    if (!opt) return null;
    return opt.hint ? `${opt.label}(${opt.hint})` : opt.label;
  }

  // v54: 구간 버튼의 "가장 낮은 구간"(freqOptions/amtOptions 배열의
  // 첫 옵션)에 이미 있는 항목은 더 줄이라고 할 대상이 아니다 —
  // "장보기를 거의 안 하는데 줄이세요"처럼 모순된 팁이 나왔던
  // 근본 원인이라, 팁 후보를 만들기 전에 걸러낸다.
  function isLowestOption(options, value) {
    return !!options?.length && value === options[0].value;
  }

  function personalizedTipLines(groupId) {
    const detail = SPEND_GROUP_DETAILS[groupId];
    const saved = state.spendingDetail?.[groupId];
    if (!detail || !saved) return [];

    const candidates = []; // {cutManwon, text} — 절약 효과 큰 순으로 우선 노출한다.

    detail.fields.forEach((f) => {
      // 장보기는 "쓰는 쪽"이 아니라 "대신 늘려야 할 쪽"이다 — 지출이
      // 아무리 커도 "장보기를 줄이세요"는 성립하지 않으므로 독립 팁
      // 후보에서 아예 뺀다. 배달/외식 쪽에서 장보기가 낮으면 두 항목을
      // 하나로 묶어 안내한다(아래 dining 분기).
      if (groupId === "g-food" && f.id === "grocery") return;

      const s = saved[f.id];
      if (!s) return;

      if (f.mode === "freq-avg" && s.freq > 0 && s.avg > 0) {
        if (isLowestOption(f.freqOptions, s.freq)) return;

        // 1회분(주간 항목이면 4.3주, 월간 항목이면 그대로)을 줄였을 때
        // 아끼는 돈 — 본 계산식(freq×avg×multiplier)과 같은 multiplier를
        // 써서 화면의 카테고리 총액과 항상 같은 셈법을 쓴다.
        const cutManwon = Math.round((s.avg * f.multiplier) / 10000);
        const freqLabel = optionLabelFor(f.freqOptions, s.freq);
        const avgLabel = optionLabelFor(f.avgOptions, s.avg);
        if (cutManwon <= 0 || !freqLabel || !avgLabel) return;

        // 배달/외식은 잦은데 장보기는 거의 안 한다면, "배달을 줄이세요"와
        // "장보기를 줄이세요"(모순) 두 개 대신 "대신 장을 보라"는 하나의
        // 연결 조언으로 합친다.
        if (groupId === "g-food" && f.id === "dining") {
          const grocery = detail.fields.find((x) => x.id === "grocery");
          const gs = saved.grocery;
          if (grocery && gs?.freq > 0 && isLowestOption(grocery.freqOptions, gs.freq)) {
            const groceryLabel = optionLabelFor(grocery.freqOptions, gs.freq);
            candidates.push({
              cutManwon,
              text: `${f.label}${josa(f.label, "을", "를")} ${freqLabel}, 1회 ${avgLabel} 정도 쓰는 반면 ${grocery.label}${josa(grocery.label, "은", "는")} ${groceryLabel} 정도예요. 배달/외식 대신 장을 봐서 집밥 비중을 늘리면 식비를 더 아낄 수 있어요 — 한 번만 줄이면 한 달에 약 ${cutManwon}만원이에요.`,
            });
            return;
          }
        }

        candidates.push({
          cutManwon,
          text: `${f.label}${josa(f.label, "을", "를")} ${freqLabel}, 1회 ${avgLabel} 정도 쓰고 계세요. 한 번만 줄이면 한 달에 약 ${cutManwon}만원을 아낄 수 있어요.`,
        });
        return;
      }

      if (f.mode === "direct" && s.amt > 0) {
        if (isLowestOption(f.amtOptions, s.amt)) return;
        // 알뜰폰을 이미 쓰고 있으면 "알뜰폰으로 바꾸세요" 류의 통신비
        // 팁은 이미 실천 중인 조언이라 의미가 없다 — 건너뛴다.
        if (groupId === "g-move" && f.id === "phone-cost" && saved["phone-plan"]?.value === "yes") return;

        const amtManwon = Math.round(s.amt / 10000);
        const cutManwon = Math.round((s.amt * 0.1) / 10000);
        if (amtManwon <= 0 || cutManwon <= 0) return;

        // 자차로 이동하는 사람에게는 "10% 줄이세요"보다 대중교통 전환이
        // 더 실행 가능한 조언이다 — "주 이용 수단"(select)은 그동안
        // 팁 문구에 전혀 쓰이지 않던 응답이었다. 절약액(10%컷) 계산은
        // 그대로 두고, 조언 문장만 이동 수단을 반영해 바꾼다.
        if (groupId === "g-move" && f.id === "commute-cost" && saved["commute-mode"]?.value === "car") {
          candidates.push({
            cutManwon,
            text: `자차로 ${f.label}이 월 ${amtManwon}만원 정도예요. 대중교통으로 바꾸면 부담을 줄일 수 있어요 — 10%만 줄여도 한 달에 약 ${cutManwon}만원이에요.`,
          });
          return;
        }

        candidates.push({
          cutManwon,
          text: `${f.label} 지출이 월 ${amtManwon}만원 정도예요. 10%만 줄여도 한 달에 약 ${cutManwon}만원을 아낄 수 있어요.`,
        });
      }
    });

    // v48의 "가장 구체적인 팁 1~2개 우선 노출" 원칙을 실제 절약 효과
    // 크기로 줄 세워 구현한다 — 후보가 이미 위에서 모순(낮은 구간·
    // 장보기 단독 등)을 걸러낸 뒤라, 정렬만으로 우선순위가 자연히
    // 정해진다.
    return candidates.sort((a, b) => b.cutManwon - a.cutManwon).slice(0, 2).map((c) => c.text);
  }

  function tipBoxHtml(groupId, groupName, title) {
    const tips = SPEND_TIPS[groupId];
    if (!tips) return "";
    const personalized = personalizedTipLines(groupId);
    return `
      <div class="tip-box">
        <p class="tip-title">${title || `${groupName} 지출, 이렇게 줄여보세요`}</p>
        ${personalized.length ? `
          <p class="tip-personalized-label">답변 기준 맞춤 팁</p>
          <ul class="tip-personalized">${personalized.map((t) => `<li>${t}</li>`).join("")}</ul>` : ""}
        <ul>${tips.map((t) => `<li>${t}</li>`).join("")}</ul>
      </div>`;
  }

  const spendingTotal = (spending) =>
    Object.values(spending).reduce((sum, value) => sum + (Number(value) || 0), 0);

  // 통계 원본(personas.js)은 0.1만 원 단위까지 나오지만, 돈 관련 숫자는
  // 화면 어디서도 소수점을 보이지 않기로 했다 — 상태에 들어오는 순간부터
  // 정수로 반올림해 이후 어떤 계산·표시도 다시 소수를 만들지 않게 한다.
  const roundSpending = (spending) =>
    Object.fromEntries(Object.entries(spending).map(([key, value]) => [key, Math.round(value)]));

  // 총액은 체감하기 쉬운 입력이고, 개인 물가는 지출 비중으로 계산된다.
  // 그래서 총액을 바꿀 때는 통계에서 온 비중을 유지한 채 항목들을 같이
  // 조정한다. keys를 생략하면(전체 12개) "월 생활비" 총액 편집에 쓰이고,
  // 일부만 넘기면(그룹 멤버 2~3개) 그룹 총액 편집에 쓰인다 — 로직은
  // 하나인데 대상 범위만 다르다.
  function scaleSpending(spending, nextTotal, keys = Object.keys(spending), fallbackSpending = null) {
    let subset = Object.fromEntries(keys.map((k) => [k, spending[k] || 0]));
    let current = spendingTotal(subset);
    const zeroed = Object.fromEntries(keys.map((key) => [key, 0]));
    if (nextTotal <= 0) {
      return { ...spending, ...zeroed };
    }

    // 한 번 0원으로 만든 뒤 다시 금액을 올리면 현재 비중만으로는 복구할
    // 기준이 없다. 온보딩에서는 선택한 생활 유형의 통계 비중을 넘겨 받아
    // 그 비중으로 되살린다. fallback도 비어 있는 예외적인 경우에만 균등
    // 배분해, 양수를 입력했는데 상태가 계속 0으로 남는 일은 막는다.
    if (current <= 0) {
      subset = Object.fromEntries(keys.map((k) => [k, fallbackSpending?.[k] || 0]));
      current = spendingTotal(subset);
      if (current <= 0) {
        subset = Object.fromEntries(keys.map((k) => [k, 1]));
        current = keys.length;
      }
    }
    const scale = nextTotal / current;
    const scaled = Object.fromEntries(Object.entries(subset).map(([key, value]) =>
      [key, Math.round(value * scale)]));
    // 항목별 반올림 뒤 생기는 오차(만 원 단위)는 대상 범위 안에서 가장 큰
    // 항목에 합쳐 총액과 화면 합계가 정확히 같게 만든다.
    const largest = Object.keys(scaled).sort((a, b) => scaled[b] - scaled[a])[0];
    const roundingGap = Math.round(nextTotal - spendingTotal(scaled));
    if (largest && roundingGap) {
      scaled[largest] = Math.max(0, scaled[largest] + roundingGap);
    }
    return { ...spending, ...scaled };
  }

  const state = {
    market: null, cpi: null, meta: null,
    goalRisk: "balanced",
    // 사용자가 비중을 직접 맞추면 여기 들어간다. null이면 선택한 성향 그대로.
    customWeights: null,
    inflation: 2.8, inflationLive: false,
    picks: new Set(["kodex200", "sp500", "gold"]),
    startMonth: null,
    timeComparisonEnd: null,
    spending: roundSpending(PERSONAS[DEFAULT_PERSONA].spending),
    spendingDetail: {},
    persona: DEFAULT_PERSONA,
    personalRate: null,
  };

  // 카드 4~7의 핵심 연봉 계산은 화면 설명대로 개인 물가를 기준으로 한다.
  // 개인 물가를 계산할 지출값이 없을 때만, 품목별 개인 물가와 같은 월인
  // 스냅샷 공식 CPI를 쓴다. 최신 전체 CPI(state.inflation)는 발표 시점에
  // 더 새 달이 들어올 수 있어 이 계산에 섞지 않고 비교·참고값으로 둔다.
  function diagnosticInflation() {
    if (Number.isFinite(state.personalRate)) return state.personalRate;
    const snapshotOfficial = state.cpi?.latest?.yoy;
    return Number.isFinite(snapshotOfficial) ? snapshotOfficial : state.inflation;
  }

  // 카드뉴스 덱의 공개 인터페이스. setupCardDeck()이 채워 넣는다.
  // setupHomeFlow()/setupNextSteps()가 실제로 이 메서드를 "호출"하는
  // 시점은 항상 boot() 전체가 끝난 뒤(사용자 상호작용 시점)라, 이
  // 선언이 setupCardDeck()보다 먼저 나올 필요는 없지만, boot()에서
  // setupCardDeck()을 setupHomeFlow()보다 먼저 호출해 반드시 채워
  // 넣은 뒤에 쓰도록 순서를 지킨다(재방문자는 setupHomeFlow() 안에서
  // 곧바로 CardDeck.open()을 부르기 때문).
  const CardDeck = {};

  /* 지금 적용 중인 배분. 사용자가 슬라이더로 맞췄으면 그것을, 아니면
     선택한 성향의 프리셋을 쓴다. 진단·목표 탭이 같은 값을 봐야 해서
     한 곳에서만 결정한다. */
  function activePlan() {
    if (state.customWeights) {
      const custom = E.customPlan(state.market, state.customWeights);
      if (custom) return custom;
    }
    return E.planOf(state.market, state.goalRisk);
  }

  /* ══════════════ 부팅 ══════════════ */
  async function boot() {
    initTheme();
    const introMascotBox = $("#introMascot");
    if (introMascotBox && window.Mascot) {
      introMascotBox.innerHTML = Mascot.svg("greet", { size: 88 }) + Mascot.bubbleHtml("greet");
    }
    try {
      const [market, cpi, meta] = await Promise.all([
        fetch("data/market.json").then((r) => r.json()),
        fetch("data/cpi.json").then((r) => r.json()),
        fetch("data/meta.json").then((r) => r.json()),
      ]);
      state.market = market;
      state.cpi = cpi;
      state.meta = meta;
    } catch (err) {
      document.querySelector("main").insertAdjacentHTML("afterbegin",
        `<div class="load-error">데이터를 불러오지 못했습니다 (${err.message}).
         새로고침해도 같으면 <code>data/market.json</code>이 배포됐는지 확인해 주세요.</div>`);
      return;
    }

    // 스냅샷의 물가상승률을 기본값으로 먼저 세팅 (실시간이 오면 덮어씀)
    state.inflation = state.cpi.latest.yoy;

    setupNumberInputGuards();
    setupMineTab();
    setupGapTab();
    setupGoalTab();
    setupTimeTab();
    // setupHomeFlow()가 재방문자면 그 안에서 곧바로 renderSummary() →
    // CardDeck.open()을 부르므로, 덱이 먼저 준비돼 있어야 한다.
    setupCardDeck();
    setupHomeFlow();
    setupReportEditing();
    $("#mixReset").addEventListener("click", () => {
      state.customWeights = null;
      renderAll();
    });
    setupNextSteps();
    setupPdfDownload();
    setupScrollReveal();
    setupScrollTopButton();
    renderBasis();
    renderAll();

    // 실시간은 화면이 다 그려진 뒤에 붙인다 (실패해도 화면은 이미 완성)
    hydrateLive();
  }

  /* ══════════════ 실시간 ══════════════ */
  async function hydrateLive() {
    const res = await window.Live.fetchAll();
    renderTicker(res);

    $("#inflSource").classList.remove("skeleton-bar");
    if (res.inflation.ok) {
      const d = res.inflation.data;
      state.inflation = d.value;
      state.inflationLive = true;
      $("#inflSource").innerHTML =
        `<span class="live-dot" style="display:inline-block;vertical-align:middle"></span>
         접속 시 최신값 조회 · OECD ${d.month} 공식 물가 <b>${d.value.toFixed(1)}%</b> · 연봉 진단은 내 지출 기준 개인 물가를 사용합니다.`;
      renderAll();
      refreshFinalConclusionIfStarted();
    } else {
      $("#inflSource").innerHTML =
        `<span class="live-dot stale" style="display:inline-block;vertical-align:middle"></span>
         저장된 공식 물가 · ${state.cpi.latest.month} 기준 ${state.cpi.latest.yoy.toFixed(1)}%
         (최신값 조회 실패 · 연봉 진단은 내 지출 기준 개인 물가 사용)`;
    }

    // 비트코인 실시간 시세는 전체 요약바가 아니라, 실제로 관련 있는
    // 자산 타임머신 탭 안에서만 보여준다 — 첫인상에서 주제가 흩어지지 않게.
    // hidden으로 통째로 숨겼다 나타내면 그 자리 높이가 0→실제값으로
    // 바뀌면서 아래 내용이 밀린다. 스켈레톤을 기본으로 깔아 자리를
    // 미리 잡아 두고, 값이 오면 내용만 바꾼다.
    if (res.btc.ok) {
      const d = res.btc.data;
      const dir = d.delta == null ? "" :
        `<span class="delta ${d.delta >= 0 ? "up" : "down"}">${d.delta >= 0 ? "▲" : "▼"}${Math.abs(d.delta).toFixed(2)}%</span>`;
      $("#btcLiveNote").classList.remove("skeleton-bar");
      $("#btcLiveNote").innerHTML =
        `<span class="live-dot" style="display:inline-block;vertical-align:middle"></span>
         실시간 비트코인 시세 <b>${man(d.value / 10000)}만원</b> ${dir} (24시간)`;
    } else {
      // 조회 자체가 실패했을 땐 보여줄 값이 없으니 자리표시자를 접는다.
      $("#btcLiveNote").hidden = true;
    }
  }

  function renderTicker(res) {
    const items = [];

    if (res.inflation.ok) {
      const d = res.inflation.data;
      const dir = d.delta == null ? "" :
        `<span class="delta ${d.delta >= 0 ? "up" : "down"}">${d.delta >= 0 ? "▲" : "▼"}${Math.abs(d.delta).toFixed(2)}%p</span>`;
      items.push(`<span class="tick"><span class="live-dot"></span><span class="lbl">소비자물가</span>
        <b>${d.value.toFixed(1)}%</b>${dir}<span class="lbl">${d.month}</span></span>`);
    } else {
      items.push(`<span class="tick"><span class="live-dot stale"></span><span class="lbl">소비자물가</span>
        <b>${state.cpi.latest.yoy.toFixed(1)}%</b><span class="lbl">${state.cpi.latest.month} 스냅샷</span></span>`);
    }

    if (res.fx.ok) {
      const d = res.fx.data;
      items.push(`<span class="tick"><span class="live-dot"></span><span class="lbl">원/달러</span>
        <b>${man(d.value)}원</b><span class="lbl">${d.date}</span></span>`);
    }

    const snap = new Date(state.market.source_fetched_at);
    items.push(`<span class="tick"><span class="live-dot stale"></span><span class="lbl">시세 스냅샷</span>
      <b>${snap.getFullYear()}.${String(snap.getMonth() + 1).padStart(2, "0")}.${String(snap.getDate()).padStart(2, "0")}</b>
      <span class="lbl">주 1회 갱신</span></span>`);

    $("#ticker").innerHTML = items.join("");
  }

  /* ══════════════ 홈 · 온보딩 → 로딩 → 요약 ══════════════
     Q1~Q5을 순서대로 물어보고, 답을 각 섹션의 실제 입력(persona 버튼·
     월 생활비·연봉 필드·투자성향 세그먼트·목표 필드)에 그대로 반영한다.
     설문 중에는 리포트 4개 섹션과 탭을 전부 숨겨 둔다 — 아직 안 끝난
     설문 아래로 결과가 미리 보이면 안 된다. 설문을 마치면(또는
     재방문자면) 한꺼번에 드러낸다. 한 번 마치면 localStorage에 저장해
     재방문 시 다시 묻지 않는다. */
  // 서비스명은 "연봉 성적표" → "연봉닥터"(v22)로 두 번 바뀌었지만 키는
  // 그대로 둔다 — 이미 저장된 기존 사용자의 값과의 연결이 끊기기만
  // 할 뿐 바꿔서 얻는 게 없다.
  const ONBOARD_KEY = "salarygap-profile";
  // v47: Q2(월 생활비)가 카테고리 5개짜리 개별 화면으로 나뉘면서
  // 3단계(생활유형/월생활비/연봉)에서 7단계로 늘었다(생활유형 + 식비·
  // 주거·생활·교통·통신·여가·문화·건강·기타 5개 + 연봉).
  // v51: 카테고리 5개를 다 채운 뒤 연봉으로 바로 넘어가기 전에, 지금까지
  // 답한 내용을 텍스트로 확인하는 "전체 요약" 화면을 독립 스텝으로
  // 끼워 넣어 8단계가 됐다.
  const TOTAL_STEPS = 8;
  const SUMMARY_STEP = 7;

  // v8: 내 물가·실질임금 진단·결론은 이제 긴 스크롤이 아니라 카드뉴스
  // 덱(#deck, setupCardDeck 참고) 하나로 합쳐졌다. 목표 자산/타임머신은
  // 여전히 별도 화면이라 따로 다룬다 — 재입력 시엔 다시 접힌 상태로
  // 되돌려야 이전에 펼쳤던 상태가 남아있지 않는다.
  function setReportVisible(visible) {
    $("#deck").hidden = !visible;
    $("#ticker").hidden = !visible;
    $("#basis").hidden = !visible;
    if (!visible) {
      $("#panel-goal").hidden = true;
      $("#panel-time").hidden = true;
    }
  }

  const personaDefaultTotal = (persona) =>
    Math.round(spendingTotal((PERSONAS[persona] || PERSONAS[DEFAULT_PERSONA]).spending));

  /* 설문값(월 생활비·세부 지출·연봉)은 리포트에서 읽기 전용이라 여기 없다
     — 바꾸려면 "처음부터 다시 입력하기"로 설문을 다시 풀어야 한다. 목표
     자산은 설문 문항이 아니라 리포트 안의 "직접 넣어보는" 계산기라 계속
     편집 가능하고, 고친 값은 새로고침 후에도 남도록 저장까지 반영한다. */
  const REPORT_FIELDS = {
    goalAmount: "goalAmount",
    goalCurrent: "goalCurrent",
    goalYears: "goalYears",
    goalMonths: "goalMonths",
  };

  function persistReportEdits() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(ONBOARD_KEY)); } catch { saved = null; }
    if (!saved) return;   // 설문을 마치지 않은 상태면 건드리지 않는다
    for (const [key, id] of Object.entries(REPORT_FIELDS)) {
      const el = $(`#${id}`);
      if (el) saved[key] = Math.max(0, +el.value || 0);
    }
    try { localStorage.setItem(ONBOARD_KEY, JSON.stringify(saved)); } catch { /* 저장 실패는 무시 */ }
  }

  function setupReportEditing() {
    Object.values(REPORT_FIELDS).forEach((id) => {
      const el = $(`#${id}`);
      if (el) el.addEventListener("change", persistReportEdits);
    });
  }

  function setInputAndFire(sel, value) {
    if (value == null) return;
    $(sel).value = value;
    $(sel).dispatchEvent(new Event("input", { bubbles: true }));
  }

  // 투자 성향은 이제 설문에서 안 묻는다 — 목표 자산 탭의 #riskCompare에서
  // 직접 고른다(state.goalRisk 기본값 "balanced"가 그때까지의 fallback).
  // goalAmount 등은 그 탭이 열릴 때까지 쓰이는 안전한 기본값일 뿐이다
  // (applyOnboardProfile이 그대로 반영).
  function freshDraft() {
    return {
      persona: DEFAULT_PERSONA,
      monthlySpend: personaDefaultTotal(DEFAULT_PERSONA),
      spending: roundSpending(PERSONAS[DEFAULT_PERSONA].spending),
      // v46: "자세히 입력하기"에 답한 소비 습관 원본(횟수·1회평균)을
      // 그룹별로 보관한다. 지금 당장 쓰는 곳은 없다 — 계산엔 이미
      // draft.spending에 반영된 결과만 쓰이고, 이 원본은 나중에
      // AI 해설 프롬프트를 더 구체화할 때(v46 후속 작업) 쓸 재료다.
      spendingDetail: {},
      curSalary: 3600, nextSalary: 3750,
      goalAmount: 0, goalYears: 1, goalMonths: 0, goalCurrent: 0,
    };
  }

  // 문항에서 받은 답을 실제 리포트 입력(내 물가·실질임금 진단·목표 자산)에
  // 그대로 반영한다. persona부터 눌러야 월 생활비 스케일링이 그 지출
  // 비중을 기준으로 계산된다.
  function applyOnboardProfile(profile) {
    applyPersona(profile.persona || DEFAULT_PERSONA);

    // 설문에서 항목별로 실제 입력한 지출이 있으면 그대로 이어받는다 —
    // persona 클릭이 방금 비례 재분배로 덮어썼을 수 있으니 그 다음에
    // 덮어써야 사용자가 직접 조정한 값이 뭉개지지 않는다.
    if (profile.spending) {
      state.spending = profile.spending;
      syncSpendingFields();
    }
    // v46: 예전에 저장된(spendingDetail 없는) 답변으로 재방문해도
    // 깨지지 않게 기본값을 채워 둔다.
    state.spendingDetail = profile.spendingDetail || {};

    if (profile.monthlySpend != null) setInputAndFire("#monthlySpend", profile.monthlySpend);
    setInputAndFire("#curSalary", profile.curSalary);
    setInputAndFire("#nextSalary", profile.nextSalary);
    setInputAndFire("#goalAmount", profile.goalAmount);
    setInputAndFire("#goalYears", profile.goalYears);
    setInputAndFire("#goalMonths", profile.goalMonths);
    setInputAndFire("#goalCurrent", profile.goalCurrent);
    renderAll();
  }

  // v21: "연봉 성적표" 점수 위젯(링·등급·톤)을 없앴다 — 결론을 맨
  // 앞으로 당기면서 점수가 결론과 같은 자리를 두고 경쟁하는 게
  // 어색해졌고, 점수 자체도 실질임금·물가 두 신호를 다시 섞어 만든
  // 부차적인 숫자라 결론 문장이 이미 하는 말을 한 번 더 반복하는
  // 셈이었다. 카드1(결론부터)의 갭 막대그래프만 여기서 채운다 —
  // 결론 문구(#finalBody)는 건드리지 않는다. 카드가 처음 화면에
  // 나타날 때(카드덱이 열리며 index 0에 도달) typeFinalConclusionOnce()
  // 가 타이핑 연출과 함께 채우는데, 여기서 매번 다시 쓰면 그 타이핑
  // 도중에 덮어써 버릴 수 있다(예전엔 카드7/마지막 카드에서 쓰던
  // 것과 같은 이유로 같은 원칙을 지킨다).
  function renderFrontConclusion() {
    const cur = Math.max(0, +$("#curSalary").value || 0);
    const next = Math.max(0, +$("#nextSalary").value || 0);
    const gap = buildGapVerdictLines(cur, next);
    const gapChartBox = $("#homeGapChart");
    if (!gapChartBox) return;
    if (gap) {
      gapChartBox.hidden = false;
      barChart(gapChartBox, [
        { label: "내년 연봉", value: next, color: gap.d.beatsInflation ? "var(--good)" : "var(--series-1)" },
        { label: "물가 유지선", value: gap.d.requiredSalary, color: "var(--reference)" },
      ]);
    } else {
      gapChartBox.hidden = true;
    }

    // 진단 결과에 맞춰 마스코트 표정을 고른다 — 물가를 이기면 밝은
    // 표정(good), 못 이겨도 걱정스러운 표정이 아니라 안심시키는
    // 표정(reassure)을 쓴다("경고보다 소견"이라는 톤 방향과 맞춘다).
    const mascotBox = $("#homeMascot");
    if (mascotBox && window.Mascot) {
      const pose = !gap ? "greet" : gap.d.beatsInflation ? "good" : "reassure";
      mascotBox.innerHTML = Mascot.svg(pose, { size: 108 }) + Mascot.bubbleHtml(pose);
    }
  }

  // 목표 기간을 "년"과 "개월" 두 필드로 나눠 받다 보니, 이 값을 쓰는
  // renderGoal·renderPrintMeta 두 곳이 각자 따로 읽고 클램프하면
  // 어긋나기 쉽다. 한 곳에서만 읽고 총 개월 수로 변환해 나머지는 이
  // 결과만 쓰게 한다.
  function readGoalDuration() {
    const years = Math.max(0, Math.min(40, +$("#goalYears").value || 0));
    const extraMonths = Math.max(0, Math.min(11, +$("#goalMonths").value || 0));
    return { years, extraMonths, months: years * 12 + extraMonths };
  }
  const formatDuration = (totalMonths) => {
    const y = Math.floor(totalMonths / 12), m = totalMonths % 12;
    if (y <= 0) return `${m}개월`;
    return m ? `${y}년 ${m}개월` : `${y}년`;
  };

  // 사주풀이처럼 숫자 하나만 던지지 않고, 물가·연봉·목표를 하나의
  // 이야기로 엮어서 풀어준다. 각 문장은 실제 계산 결과(요약 화면에
  // 도달했다는 건 renderAll이 이미 다 채워 놨다는 뜻)를 그대로 쓴다.
  // 문장마다 줄을 바꿔서(\n) 반환한다 — 한 단락으로 흘려 쓰면 읽기
  // 힘들어서, 한 문장 = 한 줄로 끊어 가독성을 높인다. CSS의
  // white-space:pre-line이 이 줄바꿈을 그대로 살린다.
  // 문장이 한 글자씩 나타나는 연출 — 결과를 "읽어주는" 느낌을 준다.
  // 요약 화면 문단과 마지막 결론 문단, 두 곳에서 동시에 쓰일 수 있어
  // 타이머를 변수 하나로 공유하면 한쪽이 다른 쪽을 끊어버릴 수 있다.
  // WeakMap으로 대상 엘리먼트마다 자기 타이머를 따로 가지게 한다.
  const typewriterTimers = new WeakMap();
  function typewriter(el, text, speed = 10) {
    const prev = typewriterTimers.get(el);
    if (prev) {
      clearInterval(prev.interval);
      clearTimeout(prev.watchdog);
      el.removeEventListener("click", prev.skip);
    }
    el.classList.remove("typing-cursor");
    el.textContent = "";
    if (!text) { typewriterTimers.delete(el); return; }
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = text;
      typewriterTimers.delete(el);
      return;
    }
    el.classList.add("typing-cursor");
    const start = Date.now();
    let interval, watchdog;
    const finish = () => {
      clearInterval(interval);
      clearTimeout(watchdog);
      el.textContent = text;
      el.classList.remove("typing-cursor");
      el.removeEventListener("click", finish);
      typewriterTimers.delete(el);
    };
    // 매 tick마다 1글자씩 더하는 대신 "시작 시각 대비 몇 글자째여야 하는가"를
    // 계산한다. 탭이 백그라운드로 갔다 온 직후처럼 브라우저가 setInterval을
    // 오래 지연시켰다 몰아서 재개하는 상황에서도, 다음 tick이 흐른 시간만큼
    // 알아서 따라잡아 자연스럽게 이어진다 (카운트업 방식은 이런 지연을
    // 그대로 누적시켜 끝에 안 닿고 멈춘 것처럼 보일 수 있었다).
    interval = setInterval(() => {
      const i = Math.floor((Date.now() - start) / speed);
      if (i >= text.length) { finish(); return; }
      el.textContent = text.slice(0, i);
    }, speed);
    // 위 tick 자체가 어떤 이유로든 더 이상 안 불리는 극단적인 경우를 대비한
    // 최후의 안전장치 — 예상 완료 시각이 지나면 무조건 전체 문장을 채우고
    // 커서를 지운다. 커서가 영원히 깜빡이며 멈춰 있는 상태는 없어야 한다.
    watchdog = setTimeout(finish, text.length * speed + 2000);
    // 다 나오기 전에 클릭하면 바로 전체 문장을 보여준다 — 타이핑이 오래
    // 걸리면 로딩이 멈춘 것처럼 보인다는 피드백이 있어 건너뛸 방법을 준다.
    el.addEventListener("click", finish);
    typewriterTimers.set(el, { interval, watchdog, skip: finish });
  }

  // 연봉을 아직 입력하지 않았을 때(cur <= 0)만 쓰는 대체 문구 —
  // buildGapVerdictLines()가 null을 돌려주는 경우 buildFinalConclusion()
  // 의 폴백으로 쓰인다.
  function buildConclusionHeadline() {
    const rate = diagnosticInflation();
    if (!Number.isFinite(rate)) return null;
    const label = Number.isFinite(state.personalRate) ? "체감 물가" : "공식 물가";
    return `${label} ${rate.toFixed(1)}%를 따라잡으려면 연봉을 그만큼 올려받거나, 그만큼 수익을 내야 해요.`;
  }

  // 카드3("얼마나 비싸게 살고 있나")의 "범인" 랭킹 1위를 그대로 다시
  // 계산한다 — renderMine()의 지역 변수(cause)를 그대로 재사용할 수는
  // 없으므로, 같은 E.personalInflation/E.aggregateByGroup 호출을
  // 그대로 반복해 같은 값을 얻는다(카드3과 결론 카드가 다른 1위를
  // 말하면 안 되니까).
  function rankedSpendCauses() {
    const cats = state.cpi.categories || [];
    if (!cats.length) return [];
    const result = E.personalInflation(state.spending, cats);
    if (!result) return [];
    return E.aggregateByGroup(result.contributions, SPEND_GROUPS)
      .sort((a, b) => b.contribution - a.contribution)
      .filter((g) => g.amount > 0);
  }

  // "유독 많이 오른" 항목 = 내 물가(가중평균) 자체보다 더 빨리 오르고
  // 있는 항목만 후보로 삼는다. 카드3의 "범인" 랭킹(비중×상승률이 큰
  // 순)은 비중만 커도 위로 올라올 수 있어서 다른 질문이다 — 비중이
  // 크지만 자기 상승률은 평균보다 낮은 항목을 줄이면, 총지출이 줄면서
  // 오히려 상승률이 더 높은 다른 항목의 비중이 커져 내 물가가
  // 올라가는 역설이 생길 수 있다(실제로 이 필터 없이 구현했다가
  // "식비 5% 절감 시 내 물가가 오히려 오른다"는 결과가 나와서 발견).
  // "줄이면 실제로 개선되는" 항목만 후보로 쓰기 위해 rate >
  // baselineRate로 거른다. 카드1 결론의 케이스 B 문구, 카드5 격차
  // 팁, 시나리오 계산이 전부 이 정의를 공유.
  function rankedAboveAverageCauses() {
    const cats = state.cpi.categories || [];
    if (!cats.length) return { baselineRate: null, list: [] };
    const baseline = E.personalInflation(state.spending, cats);
    if (!baseline) return { baselineRate: null, list: [] };
    const list = rankedSpendCauses().filter((g) => g.rate > baseline.rate);
    return { baselineRate: baseline.rate, list };
  }

  function topSpendingCause() {
    return rankedAboveAverageCauses().list[0] || null;
  }

  // 시나리오 계산이 쓰는 "지출을 pct%만큼 줄인 가상의 spending 객체"
  // 생성기. state.spending을 직접 건드리지 않고 복사본만 돌려준다.
  function reduceGroupSpending(spending, groupId, pct) {
    const group = SPEND_GROUPS.find((g) => g.id === groupId);
    if (!group) return spending;
    const adjusted = { ...spending };
    group.members.forEach((id) => {
      if (adjusted[id] != null) adjusted[id] = adjusted[id] * (1 - pct / 100);
    });
    return adjusted;
  }

  // 조언 수용 시나리오 — rankedAboveAverageCauses()가 고른 "줄이면
  // 실제로 개선되는" 1·2위 카테고리를 SCENARIO_CUT_PCT만큼 줄였다고
  // 가정하고, "내 물가" 계산(E.personalInflation)을 그 가상 지출로
  // 다시 돌려 새 %를 구한다. 새 계산이 아니라 기존 계산을 다른
  // 입력값으로 한 번 더 호출하는 것뿐이다.
  const SCENARIO_CUT_PCT = { first: 10, second: 5 };
  function buildSpendScenarios() {
    const cats = state.cpi.categories || [];
    if (!cats.length) return null;
    const { baselineRate, list } = rankedAboveAverageCauses();
    if (baselineRate == null) return null;
    const first = list[0];
    if (!first) return null;
    const second = list[1];

    const rateOf = (spending) => {
      const r = E.personalInflation(spending, cats);
      return r ? r.rate : baselineRate;
    };

    const scenarios = [
      { label: `${first.name} ${SCENARIO_CUT_PCT.first}% 절감`, rate: rateOf(reduceGroupSpending(state.spending, first.id, SCENARIO_CUT_PCT.first)) },
    ];
    if (second) {
      scenarios.push({ label: `${second.name} ${SCENARIO_CUT_PCT.second}% 절감`, rate: rateOf(reduceGroupSpending(state.spending, second.id, SCENARIO_CUT_PCT.second)) });
      let both = reduceGroupSpending(state.spending, first.id, SCENARIO_CUT_PCT.first);
      both = reduceGroupSpending(both, second.id, SCENARIO_CUT_PCT.second);
      scenarios.push({ label: `${first.name}+${second.name} 둘 다 절감`, rate: rateOf(both) });
    }

    return { baselineRate, scenarios, first, second };
  }

  function renderScenarios() {
    const card = $("#scenarioCard");
    if (!card) return;
    const s = buildSpendScenarios();
    if (!s) { card.hidden = true; return; }
    card.hidden = false;

    const firstClause = `${s.first.name}${josa(s.first.name, "을", "를")} ${SCENARIO_CUT_PCT.first}%`;
    const secondClause = s.second ? `, ${s.second.name}${josa(s.second.name, "을", "를")} ${SCENARIO_CUT_PCT.second}%` : "";
    $("#scenarioNote").textContent =
      `지금 지출에서 ${firstClause}${secondClause} 줄인다고 가정했을 때 내 물가가 어떻게 바뀌는지 시뮬레이션한 결과예요. 실제 절감 폭은 사람마다 다를 수 있어요.`;

    // 10%대 절감이라도 카테고리 비중이 작으면 전체 평균은 0.1%p도 안
    // 움직일 수 있다 — 1자리 반올림으로 뭉개면 세 시나리오가 다 같은
    // 값으로 보여 "달라지는 게 없다"는 잘못된 인상을 준다. 소수 둘째
    // 자리까지 보여줘서 작더라도 실제 차이를 그대로 드러낸다.
    $("#scenarioGrid").innerHTML = s.scenarios.map((sc, i) => `
      <div class="scenario-card">
        <span class="scenario-label">${["①", "②", "③"][i] || ""} ${sc.label}</span>
        <span class="scenario-rate">${s.baselineRate.toFixed(2)}%<span class="arrow">→</span><b>${sc.rate.toFixed(2)}%</b></span>
      </div>`).join("");

    // v48: AI가 하던 "어느 쪽이 더 효율적인가" 비교를 규칙으로 대체한다.
    // 시나리오 자체가 이미 실제 지출로 계산된 값이라(buildSpendScenarios),
    // 그 결과를 비교하는 것도 지어낸 판단이 아니라 사실 서술이다.
    const summaryBox = $("#scenarioSummary");
    if (summaryBox) {
      summaryBox.hidden = false;
      if (s.second) {
        const [firstSc, secondSc, bothSc] = s.scenarios;
        const moreEfficient = firstSc.rate <= secondSc.rate ? s.first : s.second;
        const lessRate = firstSc.rate <= secondSc.rate ? firstSc.rate : secondSc.rate;
        summaryBox.textContent =
          `둘 다 줄이면 ${bothSc.rate.toFixed(2)}%로 가장 크게 낮아지지만, 하나만 시작한다면 ` +
          `${moreEfficient.name} 쪽(${lessRate.toFixed(2)}%)이 더 효율적이에요.`;
      } else {
        summaryBox.textContent =
          `${s.first.name}${josa(s.first.name, "을", "를")} 줄이면 내 물가가 ` +
          `${s.baselineRate.toFixed(2)}%에서 ${s.scenarios[0].rate.toFixed(2)}%로 낮아져요.`;
      }
    }

    // 리포트 마지막 카드의 마무리 인사 — v27: 카드1은 진단 결과에 따라
    // 표정이 바뀌는데 여기는 항상 good으로 고정해 놨더니, 물가를 못
    // 따라가는 케이스(A)에서도 카드1은 안심시키는 표정인데 결론
    // 카드에서 갑자기 활짝 웃어버려 앞뒤가 안 맞아 보였다. 같은
    // buildGapVerdictLines()로 같은 케이스 판정을 다시 구해 카드1과
    // 항상 같은 표정을 쓰게 맞춘다. 마무리 문구 자체는 어느 케이스든
    // 진실인 일반적인 인사말이라 그대로 둔다.
    const scenarioMascotBox = $("#scenarioMascot");
    if (scenarioMascotBox && window.Mascot) {
      const cur = Math.max(0, +$("#curSalary").value || 0);
      const next = Math.max(0, +$("#nextSalary").value || 0);
      const gap = buildGapVerdictLines(cur, next);
      const pose = !gap ? "good" : gap.d.beatsInflation ? "good" : "reassure";
      // v44: 점선 상자를 없애면서(index.html 참고) 크기도 카드1
      // #homeMascot과 맞춘다 — 상자 안에서 작게 쓰던 56은 상자가 주던
      // 시각적 무게를 잃은 채로 남으면 더 작아 보였다.
      scenarioMascotBox.innerHTML = Mascot.svg(pose, { size: 108 }) +
        Mascot.bubbleHtml(pose, "처방전 잘 챙기시고, 오늘도 건강한 재정 되세요!");
    }
  }

  // 결론(카드1)의 핵심 1~2문장 — 연봉 입력이 있으면(cur > 0) 카드4
  // ("내 연봉 vs 물가")의 물가 유지선 계산(E.diagnose)을 그대로
  // 재사용해 "방어하려면 얼마"/"이미 넘었다"처럼 실제 금액이 박힌
  // 문장으로 만든다. 새 계산 로직이 아니라 카드4가 쓰는 것과 같은
  // 값이라, 두 카드의 숫자가 어긋나지 않는다. renderFrontConclusion()
  // (갭 막대그래프)과 buildFinalConclusion()(전체 결론 문단)이 이
  // 판정·문장을 공유한다. 문장 두 개를 한 줄에 이어붙이면(예: "…
  // 넘었어요. 지금 페이스라면…") 화면 폭에 따라 "유독 많이 / 오른"
  // 처럼 의미 단위 중간에서 줄바꿈될 수 있어 — 문장 하나당 배열
  // 원소 하나로 쪼갠다.
  function buildGapVerdictLines(cur, next) {
    if (cur <= 0) return null;
    const d = E.diagnose({ curSalary: cur, nextSalary: next, inflationPct: diagnosticInflation() });
    // 문장에 나란히 보이는 "내년 연봉"·"물가 유지선"은 man()으로 반올림해
    // 보여주는데, "몇 만원 더/모자란지"를 d.gap(원본 정밀 차이)로 따로
    // 반올림하면 화면 값끼리 뺀 것과 어긋날 수 있다 — 화면에 찍히는
    // 반올림 값 기준으로 다시 구한다(displayDiff, +면 부족·-면 여유로
    // d.gap과 같은 부호 규약).
    const gapDisplay = displayDiff(d.requiredSalary, next, 0);
    const lines = d.beatsInflation
      ? [
          `내년 예상 연봉(${man(next)}만원)은 물가 유지선(${man(d.requiredSalary)}만원)을 잘 넘고 있어요.`,
          "지금 페이스라면 괜찮아요 — 실질 소득이 잘 지켜지고 있어요.",
        ]
      : [
          `물가를 따라잡으려면 연봉을 최소 ${man(d.requiredSalary)}만원(${man(gapDisplay)}만원 더)까지는 처방해드릴게요.`,
          "그 차이는 투자나 협상으로 채워보세요.",
        ];
    return { d, gapDisplay, lines };
  }

  // 카드1(결론부터)의 #finalBody 전체 문단 — buildGapVerdictLines()의
  // 핵심 1~2문장에 물가를 이기는 경우(beatsInflation)는 여유분(카드4의
  // "연간 여유"와 같은 값)을 목표 자산에 보태보라는 제안과 카드3의
  // 1위 항목은 계속 지켜보라는 안내를 이어 붙인다. 투자 권유로 읽히면
  // 안 되므로 단정 대신 "~해볼 만해요" 같은 선택지 톤을 쓰고, 마지막
  // 줄에서 참고자료라는 점을 다시 한 번 짚는다.
  function buildFinalConclusion() {
    const headline = buildConclusionHeadline();
    if (headline == null) {
      return "아직 결과를 계산할 수 없어요.\n리포트에서 값을 입력하면 여기서 정리해 드릴게요.";
    }

    const cur = Math.max(0, +$("#curSalary").value || 0);
    const next = Math.max(0, +$("#nextSalary").value || 0);
    const gap = buildGapVerdictLines(cur, next);

    const lines = [];
    if (gap) {
      lines.push(...gap.lines);
      if (gap.d.beatsInflation) {
        const cause = topSpendingCause();
        const surplus = man(-gap.gapDisplay);
        lines.push(`여유분(연 ${surplus}만원)을 목표 자산에 보태보는 건 어때요?`);
        if (cause) lines.push(`다만 ${cause.name}처럼 유독 많이 오른 항목은 계속 살펴보는 게 좋아요.`);
      }
    } else {
      lines.push(headline);
    }

    lines.push("이 처방은 참고 자료일 뿐, 최종 결정은 늘 본인의 몫입니다.");
    return lines.join("\n");
  }

  // 결론 카드 타이핑 — 같은 세션 안에서 다시 볼 때도 매번 재생되면
  // 불필요하게 느껴진다는 피드백이 있어, sessionStorage에 한 번
  // 재생했다는 표시를 남기고 이후로는 완성된 문장을 바로 보여준다.
  // (v8 이전에는 스크롤로 카드에 처음 닿을 때 IntersectionObserver로
  // 트리거했는데, 카드뉴스 덱은 transform으로 카드를 넘기지 실제
  // 스크롤이 아니라서 그 방식이 안 걸린다. CardDeck이 카드1(결론부터,
  // v21부터 index 0)에 처음 도달하는 순간 이 로직을 직접 호출한다 —
  // 아래 setupCardDeck 참고.)
  const FINAL_TYPED_KEY = "sr_finalConclusionTyped";
  function typeFinalConclusionOnce() {
    const body = $("#finalBody");
    const text = buildFinalConclusion();
    if (sessionStorage.getItem(FINAL_TYPED_KEY)) {
      body.textContent = text;
    } else {
      typewriter(body, text);
      sessionStorage.setItem(FINAL_TYPED_KEY, "1");
    }
  }

  // 실시간 응답이 늦게 도착해도 이미 열어 본 결론 카드가 이전 계산값에
  // 머물지 않게 한다. 타이핑 중이었다면 기존 타이머까지 정리한 뒤 최신
  // 계산문을 즉시 보여 주고, 아직 결론 카드를 열지 않았다면 건드리지 않는다.
  function refreshFinalConclusionIfStarted(force = false) {
    const body = $("#finalBody");
    if (!body || (!force && !body.textContent && !typewriterTimers.has(body))) return;

    const active = typewriterTimers.get(body);
    if (active) {
      clearInterval(active.interval);
      clearTimeout(active.watchdog);
      body.removeEventListener("click", active.skip);
      typewriterTimers.delete(body);
    }
    body.classList.remove("typing-cursor");
    body.textContent = buildFinalConclusion();
  }

  // 목표 자산/타임머신은 카드뉴스 덱이 아니라 예전처럼 독립된 화면이다.
  // 버튼을 누르면 덱을 숨기고 그 화면을 보여주고, 그 화면 맨 위의
  // "카드 리포트로 돌아가기"를 누르면 덱으로 복귀해 마지막 카드
  // (시나리오, 이 버튼들이 있던 카드)에 이어서 보여준다.
  // renderAll()이 이미 renderGoal()/renderTime()을 항상 호출해 두므로
  // 내용은 hidden 상태에서도 다 그려져 있다.
  function setupNextSteps() {
    function openStandalone(id) {
      setStage("prescription"); // 목표 자산·자산 타임머신은 카드뉴스 밖이라 syncUI가 안 돈다
      $("#deck").hidden = true;
      $("#panel-goal").hidden = true;
      $("#panel-time").hidden = true;
      const el = $(`#${id}`);
      el.hidden = false;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    function backToDeck() {
      $("#panel-goal").hidden = true;
      $("#panel-time").hidden = true;
      $("#deck").hidden = false;
      CardDeck.goToLast();
      $("#deck").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    $("#revealGoalBtn").addEventListener("click", () => openStandalone("panel-goal"));
    $("#revealTimeBtn").addEventListener("click", () => openStandalone("panel-time"));
    $$(".deck-back-btn").forEach((b) => b.addEventListener("click", backToDeck));
  }

  /* ══════════════ PDF 다운로드 ══════════════
     CLAUDE.md가 빌드 도구·npm·외부 CDN 추가를 금지하고 있어서(PR
     자동검사도 외부 CDN <script>를 막는다), html2canvas/jsPDF 같은
     라이브러리를 새로 끌어오는 대신 브라우저 네이티브 인쇄
     (window.print())를 쓴다. 사용자가 인쇄 대화상자에서 "대상"을
     PDF로 저장하면 그게 곧 다운로드다 — 대부분의 브라우저는 이미
     "PDF로 저장"이 기본 대상이다.
     라이트모드 강제·카드뉴스 세로 펼침·조작용 UI 숨김은 전부
     styles.css의 @media print 블록이 담당하고, 여기서는 파일명
     (document.title을 인쇄 시점에만 잠깐 바꾼다 — 브라우저 인쇄
     대화상자가 이 값을 파일명 기본값으로 제안한다)과 버튼의 로딩
     상태만 다룬다. 차트는 SVG라 캡처 타이밍 이슈 자체가 없다. */
  function downloadPdf(btn, filenameBase) {
    const originalTitle = document.title;
    const originalLabel = btn.textContent;
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

    btn.disabled = true;
    btn.textContent = "PDF 만드는 중…";

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      document.title = originalTitle;
      btn.disabled = false;
      btn.textContent = originalLabel;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    // afterprint를 안 쏴 주는 아주 드문 환경을 대비한 안전장치.
    setTimeout(restore, 8000);

    try {
      if (typeof window.print !== "function") throw new Error("print unsupported");
      // 목표·기간·타임머신 입력은 renderAll()을 거치지 않고 자기 화면만
      // 다시 그릴 수 있으므로, 인쇄 버튼을 누른 바로 그 시점의 값으로
      // 문서 헤더를 한 번 더 만든다.
      if (filenameBase === "연봉닥터") refreshFinalConclusionIfStarted(true);
      renderPrintMeta();
      document.title = `${filenameBase}_${dateStr}`;
      window.print();
    } catch (err) {
      restore();
      alert("다운로드에 실패했어요. 다시 시도해주세요.");
    }
  }

  function setupPdfDownload() {
    const targets = [
      ["#downloadReportBtn", "연봉닥터"],
      ["#downloadGoalBtn", "목표자산계획"],
      ["#downloadTimeBtn", "자산타임머신"],
    ];
    targets.forEach(([sel, name]) => {
      const btn = $(sel);
      if (btn) btn.addEventListener("click", () => downloadPdf(btn, name));
    });
  }

  /* ══════════════ 카드뉴스 덱 (v8) ══════════════
     카드 내용은 전혀 모르는 범용 네비게이션 엔진 — .deck-card 엘리먼트
     목록만 다룬다. renderMine()/renderGap()/renderFrontConclusion()는 전부
     $("#id")로 엘리먼트를 찾아 쓰는 구조라 이 함수와 무관하게 그대로
     동작한다(어느 카드가 감싸든 상관없다).

     이동 방법은 5가지 — 화살표 클릭, 점 클릭(임의 카드로 점프), 좌우
     화살표 키, 스와이프(Pointer Events), 좌/우 절반 탭. 전부 goTo()
     하나로 모인다.

     스와이프는 처음 8px 이동까지 축(가로/세로)을 정하지 않고 기다렸다가
     가로가 더 크면 그때부터 preventDefault해서 카드를 드래그로 옮기고,
     세로가 더 크면 그대로 둬서 카드 내부 세로 스크롤(콘텐츠가 넘치는
     카드)이 살아있게 한다.

     좌/우 절반 탭은 별도 오버레이 엘리먼트 없이 뷰포트 클릭을
     델리게이션한다 — a/button/summary/input/label로 클릭이 떨어지면
     무시해서 카드 안 토글·버튼·입력과 절대 충돌하지 않는다.

     뒤로가기는 카드 이동마다 history.pushState를 쌓는다(사용자 결정).
     덱이 처음 열릴 때만 replaceState(새 엔트리 추가 안 함 — 온보딩
     단계 전환도 히스토리를 안 쌓는 것과 일관). popstate는 덱이 보이는
     동안에만 반영한다 — 설문 중이거나 목표/타임머신 별도 화면을 보는
     중에는 무시한다(이 화면들의 전환은 히스토리에 안 엮는다). */
  function setupCardDeck() {
    const deckEl = $("#deck");
    const viewport = $("#deckViewport");
    const track = $("#deckTrack");
    const cards = $$(".deck-card");
    const dotsWrap = $("#deckDots");
    const prevBtn = $("#deckPrevBtn");
    const nextBtn = $("#deckNextBtn");
    const liveRegion = $("#deckLiveRegion");
    const FINAL_INDEX = cards.length - 1;
    let index = 0;
    // v21: 결론이 카드1(index 0)로 옮겨오면서, "처음 도달했을 때 한 번
    // 타이핑"의 기준 카드도 마지막에서 첫 카드로 바뀌었다. 초기값은
    // true(=이미 탔음)로 시작해야 한다 — setupCardDeck() 맨 끝의
    // syncUI() 최초 호출이 index=0인 채로 무조건 한 번 실행되는데,
    // 그 시점엔 온보딩이 끝나지 않아 #curSalary/#nextSalary가 아직
    // HTML 기본값(3600/3750)이다. false로 시작하면 그 기본값으로
    // 결론이 미리 타이핑되어 버렸다가, 실제 온보딩 완료 후
    // CardDeck.open()이 다시 열어도 이미 "탔다"는 오해로 그 결과가
    // 화면에 남는 버그가 생긴다(실제로 겪고 나서 고쳤다). true로 시작해
    // 이 최초 syncUI()는 건너뛰고, CardDeck.open()이 매번 명시적으로
    // false로 되돌린 뒤에만 진짜로 타이핑되게 한다.
    let frontTyped = true;

    cards.forEach((card, i) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "deck-dot";
      dot.setAttribute("role", "tab");
      dot.setAttribute("aria-label", `${i + 1}번째 카드로 이동`);
      dot.addEventListener("click", () => goTo(i));
      dotsWrap.appendChild(dot);
    });
    const dots = Array.from(dotsWrap.children);

    // v11: CSS calc(100dvh - 13rem)은 상단바+티커+점 인디케이터 높이를
    // rem 상수로 어림한 값이라, 상단바 부제목이 줄바꿈되는 화면 폭
    // (약 861~950px)처럼 실제 헤더 높이가 그 상수와 어긋나는 경우
    // 뷰포트가 살짝 더 길게 계산되고, 그만큼 카드 아래쪽을 보려고 페이지가
    // 조금 스크롤되면서 sticky 헤더가 카드 위쪽을 가리는 문제가 있었다.
    // 지금 이 엘리먼트가 화면에서 실제로 시작하는 지점(getBoundingClientRect)을
    // 기준으로 남은 높이를 직접 재서 어떤 헤더 높이·줌 배율에서도
    // 어긋나지 않게 한다.
    function syncViewportHeight() {
      if (deckEl.hidden) return;
      // 한눈에 보기 모드는 뷰포트 높이가 auto(카드 전체가 이어붙는
      // 길이)라 카드 한 장 기준 고정 높이를 강제하면 안 된다.
      if (deckEl.classList.contains("is-full-view")) return;
      const top = viewport.getBoundingClientRect().top;
      const available = window.innerHeight - top - 16;
      viewport.style.height = `${Math.max(360, Math.round(available))}px`;
    }
    let resizeRaf = null;
    window.addEventListener("resize", () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(syncViewportHeight);
    });

    function syncUI() {
      // 카드1~4("내 연봉 vs 물가"까지)는 진단, 카드5~6(연봉 협상
      // 가이드부터 결론까지)은 처방 — 카드 개수가 또 바뀌어도(v32처럼)
      // FINAL_INDEX 기준 상대 위치로 계산해서 하드코딩한 인덱스가
      // 낡지 않게 한다(뒤에서 2장 = 처방).
      setStage(index >= FINAL_INDEX - 1 ? "prescription" : "diagnosis");
      track.style.transform = `translateX(${-index * 100}%)`;
      dots.forEach((d, i) => {
        d.classList.toggle("is-current", i === index);
        d.classList.toggle("is-done", i < index);
      });
      cards.forEach((c, i) => c.setAttribute("aria-hidden", i === index ? "false" : "true"));
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index === FINAL_INDEX;
      liveRegion.textContent = `카드 ${index + 1} / ${cards.length}`;
      if (index === 0 && !frontTyped) {
        frontTyped = true;
        typeFinalConclusionOnce();
      }
      // 카드가 화면에 나타날 때(스와이프/화살표/점/키보드 전환 전부
      // goTo → syncUI를 거친다)마다 그 카드 안의 그래프·숫자가 짧게
      // 채워지는 연출을 다시 재생한다 — 미리 다 그려진 채로 넘어오지
      // 않게. window.Animate가 없으면(로드 실패 등) 조용히 건너뛴다.
      if (window.Animate) window.Animate.playCardEntrance(cards[index]);
    }

    function goTo(i, opts = {}) {
      index = Math.max(0, Math.min(FINAL_INDEX, i));
      syncUI();
      if (!opts.skipHistory) {
        history.pushState({ deckIndex: index }, "", `#card-${index + 1}`);
      }
    }

    prevBtn.addEventListener("click", () => goTo(index - 1));
    nextBtn.addEventListener("click", () => goTo(index + 1));

    document.addEventListener("keydown", (e) => {
      if (deckEl.hidden || deckEl.classList.contains("is-full-view")) return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowRight") goTo(index + 1);
      else if (e.key === "ArrowLeft") goTo(index - 1);
    });

    // ---- 스와이프 + 좌우 절반 탭 (Pointer Events, 터치·마우스 공용) ----
    let dragging = false, axis = null, startX = 0, startY = 0, deltaX = 0, moved = false;

    viewport.addEventListener("pointerdown", (e) => {
      // 한눈에 보기 모드는 세로 스크롤 문서다 — 좌우 스와이프로 카드
      // 넘기는 제스처 자체를 시작하지 않는다.
      if (deckEl.classList.contains("is-full-view")) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // 버튼/토글/입력 위에서 시작한 제스처는 스와이프로 가로채지 않는다.
      // setPointerCapture를 걸면 그 뒤에 오는 호환 click 이벤트까지
      // viewport로 재타깃되어(스펙 동작) 정작 그 버튼의 클릭 리스너가
      // 안 불리는 문제가 있었다 — 시작부터 캡처를 안 거는 게 근본 해결.
      if (e.target.closest("a, button, summary, input, label")) return;
      dragging = true; axis = null; moved = false;
      startX = e.clientX; startY = e.clientY; deltaX = 0;
      track.style.transition = "none";
      try { viewport.setPointerCapture(e.pointerId); } catch { /* 캡처 실패는 무시 — 드래그 정확도만 약간 떨어진다 */ }
    });

    viewport.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (axis === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      if (axis !== "x") return; // 세로 제스처는 카드 내부 스크롤에 그대로 맡긴다
      e.preventDefault();
      moved = true;
      // 첫 카드에서 이전 방향, 마지막 카드에서 다음 방향으로 드래그해도
      // 갈 곳이 없다 — 트랙이 살짝 밀렸다 튕겨 돌아오는 어색한 움직임
      // 대신 그 방향으로는 아예 반응하지 않게 델타를 0으로 막는다.
      const atFirstGoingPrev = index === 0 && dx > 0;
      const atLastGoingNext = index === FINAL_INDEX && dx < 0;
      deltaX = (atFirstGoingPrev || atLastGoingNext) ? 0 : dx;
      const pct = (deltaX / viewport.clientWidth) * 100;
      track.style.transform = `translateX(${-index * 100 + pct}%)`;
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      track.style.transition = "";
      if (axis === "x") {
        const threshold = viewport.clientWidth * 0.18;
        if (deltaX <= -threshold) { goTo(index + 1); return; }
        if (deltaX >= threshold) { goTo(index - 1); return; }
      }
      syncUI(); // 문턱을 못 넘었으면 원래 카드로 스냅
    }
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);

    viewport.addEventListener("click", (e) => {
      if (deckEl.classList.contains("is-full-view")) return; // 좌우 절반 탭 이동도 카드뉴스 전용
      if (moved) { moved = false; return; } // 드래그 직후의 클릭은 탭 이동으로 취급하지 않는다
      if (e.target.closest("a, button, summary, input, label")) return; // 실제 컨트롤은 원래 동작대로
      const rect = viewport.getBoundingClientRect();
      const half = rect.left + rect.width / 2;
      if (e.clientX < half) goTo(index - 1); else goTo(index + 1);
    });

    // ---- 마우스 휠: 페이지가 아니라 활성 카드 안에서만 스크롤 ----
    // .deck-viewport가 overflow:hidden이라 카드 콘텐츠가 남는 공간이
    // 없어도, 휠 이벤트 자체는 스크롤할 게 없으면 곧장 문서로 새어나가
    // 카드 밖(푸터 등)까지 스크롤되는 문제가 실제 배포본에서 확인됐다.
    // 항상 활성 카드의 scrollTop으로 델타를 직접 적용하고 preventDefault해서
    // "카드 한 장 = 화면 한 장" 밖으로 스크롤이 새지 않게 막는다.
    viewport.addEventListener("wheel", (e) => {
      // 한눈에 보기 모드는 카드가 실제 문서 흐름으로 이어붙어 있어
      // 일반 페이지 스크롤이 맞다 — 활성 카드 하나로 가두면 안 된다.
      if (deckEl.classList.contains("is-full-view")) return;
      e.preventDefault();
      cards[index].scrollTop += e.deltaY;
    }, { passive: false });

    window.addEventListener("popstate", (e) => {
      if (deckEl.hidden) return;
      const i = e.state && typeof e.state.deckIndex === "number" ? e.state.deckIndex : 0;
      index = Math.max(0, Math.min(FINAL_INDEX, i));
      syncUI();
    });

    CardDeck.open = function () {
      index = 0;
      // "처음부터 다시 입력하기"로 재입력한 뒤 다시 열리는 경우를 포함해,
      // 덱이 새로 열릴 때마다 "카드1(결론부터)에 처음 도달했다"는 상태를
      // 다시 무장한다. 이걸 안 하면 재입력 전에 카드1을 한 번이라도 본
      // 경우 frontTyped가 true로 남아 있어서, 재입력 후 다시 카드1에
      // 가도(카드덱은 항상 index 0으로 열린다) typeFinalConclusionOnce()가
      // 아예 호출되지 않고 #finalBody에 이전 입력값 기준 문구가 그대로
      // 남는 버그가 있었다(세션 재사용 시에만 재현 — 새로고침하면
      // frontTyped 자체가 초기화돼 안 보였다).
      frontTyped = false;
      syncUI();
      syncViewportHeight();
      // 열리는 시점엔 폰트·티커 실시간 값 등이 아직 자리를 잡는 중일 수
      // 있어, 페인트 한 번 지난 뒤 다시 재서 확정한다.
      requestAnimationFrame(syncViewportHeight);
      history.replaceState({ deckIndex: 0 }, "", "#card-1");
    };
    CardDeck.goToLast = function () {
      goTo(FINAL_INDEX, { skipHistory: true });
    };

    // v20 항목8 — 스와이프 카드뉴스 대신 스크롤 한 번으로 카드 전체를
    // 다 볼 수 있는 "한눈에 보기" 토글. CSS(.deck.is-full-view)가 인쇄용
    // 레이아웃을 화면에도 재사용해 카드를 세로로 펼치고, 여기서는 진입
    // 애니메이션 트리거 방식만 바꾼다 — 카드뉴스에서는 goTo가, 여기서는
    // 스크롤로 카드가 뷰포트에 들어오는 순간(IntersectionObserver)이
    // 트리거다.
    const viewToggle = $("#deckViewToggle");
    let fullViewObserver = null;
    function enterFullView() {
      deckEl.classList.add("is-full-view");
      viewToggle.textContent = "카드뉴스로 보기";
      viewToggle.setAttribute("aria-pressed", "true");
      viewport.style.height = "";

      const animated = new WeakSet();
      fullViewObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting || animated.has(entry.target)) return;
          animated.add(entry.target);
          if (window.Animate) window.Animate.playCardEntrance(entry.target);
        });
      }, { rootMargin: "0px 0px -15% 0px", threshold: 0.15 });
      cards.forEach((c) => fullViewObserver.observe(c));
    }
    function exitFullView() {
      deckEl.classList.remove("is-full-view");
      viewToggle.textContent = "한눈에 보기";
      viewToggle.setAttribute("aria-pressed", "false");
      if (fullViewObserver) { fullViewObserver.disconnect(); fullViewObserver = null; }
      syncViewportHeight();
      // 스크롤하다 넘어왔을 수 있으니, 카드뉴스로 돌아오면 지금 인덱스
      // 카드가 화면 맨 위에 오도록 다시 맞춘다.
      syncUI();
      deckEl.scrollIntoView({ behavior: "auto", block: "start" });
    }
    if (viewToggle) {
      viewToggle.addEventListener("click", () => {
        if (deckEl.classList.contains("is-full-view")) exitFullView();
        else enterFullView();
      });
    }

    syncUI();
  }

  // 리포트를 스크롤해서 내려갈 때 섹션이 하나씩 나타나게 한다 — 설문
  // 중엔 패널 자체가 hidden이라 관찰해도 안 걸리다가, 리포트가 공개된
  // 뒤 스크롤하면서 순서대로 걸린다. 한 번 나타난 블록은 다시 안 건드림
  // (스크롤을 왔다갔다 할 때마다 깜빡이면 산만하다 — typeFinalConclusionOnce와
  // 같은 이유). 카드뉴스 덱(.deck-card) 안 콘텐츠는 대상이 아니다 —
  // .bento 래퍼가 없어서 셀렉터에 애초에 안 걸린다(카드 전환 애니메이션이
  // 화면이 바뀐다는 연출을 대신한다).
  function setupScrollReveal() {
    const targets = $$(".bento > *");
    if (!targets.length) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -60px 0px" });
    targets.forEach((el) => observer.observe(el));
  }

  // 상단 탭 내비게이션이 없어서, 리포트가 길어지면 처음(설문 다시
  // 입력하기 등)으로 돌아가려면 계속 스크롤해야 한다. 일정 이상
  // 내려갔을 때만 나타나는 플로팅 버튼으로 보완한다.
  function setupScrollTopButton() {
    const btn = $("#scrollTopBtn");
    let visible = false;
    const THRESHOLD = 480;
    const sync = () => {
      const shouldShow = window.scrollY > THRESHOLD;
      if (shouldShow === visible) return;
      visible = shouldShow;
      btn.hidden = !shouldShow;
    };
    document.addEventListener("scroll", sync, { passive: true });
    sync();
    btn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function setupHomeFlow() {
    const loadingView = $("#homeLoading");
    const wizardView = $("#homeOnboarding");
    const steps = $$(".onboarding-step");
    const progressWrap = $("#onboardProgressWrap");
    const progressFill = $("#onbProgressFill");
    const progressText = $("#onbProgressText");
    let stepIndex = 0;
    let draft = freshDraft();
    // v47: 스텝 번호 → 그 화면이 다루는 지출 그룹. 카테고리 5개가 순서대로
    // 2~6번 스텝을 하나씩 차지한다.
    const STEP_GROUP = { 2: "g-food", 3: "g-home", 4: "g-move", 5: "g-play", 6: "g-etc" };
    // 아직 퀴즈 UI가 없는 카테고리(자리표시자 — 총액 직접입력만)는 여기
    // 없다. 카테고리를 순서대로 채워 나갈 때마다 한 줄씩 늘어난다.
    const STEP_QUIZ_CONTAINER = { 2: "onbFoodQuiz", 3: "onbHomeQuiz", 4: "onbMoveQuiz", 5: "onbPlayQuiz", 6: "onbEtcQuiz" };

    const loadSaved = () => {
      try { return JSON.parse(localStorage.getItem(ONBOARD_KEY)); } catch { return null; }
    };

    // 문항 내용에 따라 다음/이전 버튼 높이가 달라질 수 있고, 짧은 화면에서는
    // 버튼을 누르려고 스크롤한 채로 다음 화면(로딩·요약)으로 넘어갈 수 있다.
    // 그 상태로 두면 스크롤 위치가 다음 화면의 엉뚱한 지점(그 아래 리포트
    // 섹션)을 가리키게 되므로, 상태가 바뀔 때마다 홈 섹션 맨 위로 되돌린다.
    // #panel-home을 scrollIntoView로 스크롤하면 section의 scroll-margin-top
    // (고정 5rem)만큼만 헤더 자리를 비워두는데, 상단바 부제목이 줄바꿈되는
    // 특정 화면 폭(약 861~950px)에서는 실제 헤더 높이가 그보다 커진다.
    // 그 차이만큼 티커 스트립 전체가 고정 헤더 뒤에 가려져 안 보이는
    // 버그가 있었다. 진짜 목적은 "페이지 맨 위로"이므로 그냥 맨 위로
    // 스크롤한다 — sticky 헤더는 scrollY=0에서는 절대 겹치지 않는다.
    function scrollHomeToTop() {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }

    function showStep(i) {
      // 0(표지, 아직 "시작하기"를 안 누른 상태)은 진찰 단계로 안 친다 —
      // 설문에 실제로 들어가기 전까지는 중립 기본값(블루)을 유지하고,
      // "cover"는 어떤 .stage-pill의 data-stage와도 안 맞으므로 셋 다
      // 비활성 상태로 보인다. #onbStart가 showStep(1)을 부르는 순간부터
      // 핑크(진찰)로 바뀐다.
      setStage(i === 0 ? "cover" : "checkup");
      stepIndex = i;
      steps.forEach((s) => { s.hidden = Number(s.dataset.step) !== i; });
      progressWrap.hidden = i === 0;
      if (i > 0) {
        progressFill.style.width = `${(i / TOTAL_STEPS) * 100}%`;
        progressText.textContent = `${i} / ${TOTAL_STEPS}`;
      }
      // 방금 고른 생활 유형의 평균값을 미리 채워 둔다 — 사용자는 그대로
      // 두거나 고칠 수 있다. v47: 카테고리별 화면(2~6)이 다시 보일 때마다
      // (뒤로가기 포함) 그 그룹의 현재 총액으로 입력칸을 동기화한다.
      const groupId = STEP_GROUP[i];
      if (groupId) {
        const g = SPEND_GROUPS.find((x) => x.id === groupId);
        $(`#onb-sp-${groupId}`).value = Math.round(draftGroupTotal(g));
        // updateRunningTotal()이 renderOnbSpendSummary()도 함께 갱신하므로
        // 카드6("건강·기타") 진입 시 전체 요약도 이 한 줄로 같이 채워진다.
        updateRunningTotal();
        if (STEP_QUIZ_CONTAINER[i]) renderCategoryQuiz(groupId, STEP_QUIZ_CONTAINER[i]);
      }
      // v51: 전체 요약 화면은 "다음"으로 처음 들어올 때뿐 아니라, 연봉
      // 스텝에서 "이전"으로 돌아올 때도 매번 다시 그려야 한다 — 그 사이
      // 카테고리 화면으로 더 되돌아가 답을 바꿨을 수 있어서다.
      if (i === SUMMARY_STEP) renderOnbSummary();
      scrollHomeToTop();
    }

    function renderSummary() {
      renderFrontConclusion();
      // 설문이 끝나고 포트폴리오가 준비된 뒤에야 리포트 카드뉴스 덱이
      // 의미가 생기므로 그때 한꺼번에 드러내고, 항상 카드 1(결론부터)로
      // 보여준다.
      setReportVisible(true);
      CardDeck.open();
      scrollHomeToTop();
    }

    // 실제로는 즉시 계산되지만, 문항에 답한 뒤 결과가 "만들어지는" 느낌을
    // 잠깐 줘서 다음 화면(리포트)에 무게감을 싣는다.
    function showLoadingThenSummary() {
      wizardView.hidden = true;
      loadingView.hidden = false;
      scrollHomeToTop();
      const messages = ["당신의 물가를 계산하는 중…", "실질임금을 진단하는 중…", "리포트를 준비하는 중…"];
      let i = 0;
      $("#loadingMsg").textContent = messages[0];
      const msgTimer = setInterval(() => {
        i = (i + 1) % messages.length;
        $("#loadingMsg").textContent = messages[i];
      }, 550);
      setTimeout(() => {
        clearInterval(msgTimer);
        loadingView.hidden = true;
        renderSummary();
      }, 1650);
    }

    function finish(finalDraft) {
      localStorage.setItem(ONBOARD_KEY, JSON.stringify(finalDraft));
      applyOnboardProfile(finalDraft);
      showLoadingThenSummary();
    }

    // ---- 진입: 저장된 답이 있으면 온보딩을 건너뛰고 요약만 보여준다 ----
    const saved = loadSaved();
    if (saved) {
      wizardView.hidden = true;
      applyOnboardProfile(saved);
      renderSummary();
    } else {
      wizardView.hidden = false;
      showStep(0);
    }

    // ---- 0 · 인트로 ----
    $("#onbStart").addEventListener("click", () => showStep(1));

    // ---- 1 · 생활 유형 ----
    $$("#onbPersonaGrid button").forEach((b) => {
      b.addEventListener("click", () => {
        draft.persona = b.dataset.persona;
        draft.monthlySpend = personaDefaultTotal(draft.persona);
        draft.spending = roundSpending(PERSONAS[draft.persona].spending);
        $$("#onbPersonaGrid button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      });
    });
    $("#onbNext1").addEventListener("click", () => showStep(2));

    // ---- 2~6 · 카테고리별 지출 화면 (v47) ----
    // 리포트 "내 물가" 탭이 쓰는 SPEND_GROUPS/scaleSpending을 그대로
    // draft.spending에 적용한다 — 계산 로직을 새로 만들지 않는다.
    const draftGroupTotal = (g) => g.members.reduce((sum, id) => sum + (draft.spending[id] || 0), 0);

    // 화면 상단의 "지금까지 합계" — 선택 사항으로 요청됐지만, 카테고리
    // 화면이 5개로 늘면서 사용자가 진행 상황을 감 잡기 어려워질 수 있어
    // 넣었다. 모든 카테고리 화면이 .onb-running-total 하나씩을 갖고
    // 있으므로 값이 바뀔 때마다 전부 같이 갱신한다. 전체 요약(v51,
    // 독립 스텝)은 여기서 매번 같이 갱신하지 않는다 — showStep()이 그
    // 스텝에 들어올 때(진입·뒤로가기 공통)만 renderOnbSummary()를 불러
    // 최신 상태로 다시 그린다.
    function updateRunningTotal() {
      const text = `지금까지 합계 · 월 ${man(spendingTotal(draft.spending))}만원`;
      $$(".onb-running-total").forEach((el) => { el.textContent = text; });
    }

    // v47: 구간 버튼 퀴즈 하나(빈도 또는 1회금액)의 마크업. 버튼의
    // aria-pressed 상태가 곧 선택값이라 별도 JS 상태를 안 둔다 — Q1
    // 페르소나 선택과 같은 패턴.
    function quizButtonsHtml(fieldId, role, options, chosen) {
      return `<div class="range-grid" data-quiz="${fieldId}-${role}">
        ${options.map((o) => `
          <button type="button" data-value="${o.value}" aria-pressed="${chosen === o.value}">
            <b>${o.label}</b>${o.hint ? `<span>${o.hint}</span>` : ""}
          </button>`).join("")}
      </div>`;
    }

    // select(대중교통/자차 등)는 값이 문자열이라 숫자 변환 전 원본이
    // 필요하다 — selectedQuizValue는 그 위에 Number()만 얹은 것.
    function selectedQuizRaw(fieldId, role) {
      const pressed = document.querySelector(`[data-quiz="${fieldId}-${role}"] button[aria-pressed="true"]`);
      return pressed ? pressed.dataset.value : null;
    }
    function selectedQuizValue(fieldId, role) {
      const raw = selectedQuizRaw(fieldId, role);
      return raw == null ? null : Number(raw);
    }

    // ---- 2~6 · 카테고리별 퀴즈 (범용) ----
    // 필드의 mode에 따라 세 형태 중 하나로 그린다: "freq-avg"는 빈도·1회
    // 금액 두 질문(식비류), "direct"는 이미 월 총액으로 답하는 게 자연스러운
    // 지출(월세 등) 한 질문짜리, "select"는 금액과 무관한 선택형(대중교통/
    // 자차, 알뜰폰 여부 등 — 절약 팁 개인화용 재료, category: null이라
    // 계산에는 안 들어간다).
    // v48: 하위 항목(배달/외식·장보기·카페/음료 등)을 세로로 쭉 늘어놓지
    // 않고 탭으로 분리한다 — 탭 라벨이 곧 f.label이라 별도 제목이 필요
    // 없다. freq-avg는 빈도·금액 두 질문을 2단(가로)으로 배치하고,
    // 좁은 화면에서는 CSS(.quiz-question-pair)가 알아서 세로로 접는다.
    function quizFieldBodyHtml(f, saved) {
      if (f.mode === "select") {
        return quizButtonsHtml(f.id, "sel", f.options, saved.value);
      }
      if (f.mode === "direct") {
        return `${quizButtonsHtml(f.id, "amt", f.amtOptions, saved.amt)}<p class="field-note">${f.hint}</p>`;
      }
      // v53: "빈도 (월 기준)" 같은 소제목 라벨은 버렸다 — 대신 각 구간
      // 버튼 자체(hint 또는 label)에 "주"/"월"을 직접 박아 넣어(위
      // SPEND_GROUP_DETAILS) 버튼 하나하나가 스스로 단위를 말하게
      // 했다. 소제목에서 단위를 한 번만 말하면 그 아래 버튼 중 하나가
      // 실수로 다른 단위를 써도(장보기 "주 2회 이상" 버그처럼) 티가
      // 안 나지만, 버튼마다 명시하면 그 자리에서 바로 드러난다.
      // "거의 안 함" 옵션에 0을 포함한다는 힌트가 없는 질문(장보기·
      // 카페/음료·쇼핑·모임/술자리)은 "전혀 안 함"에 해당하는 선택지가
      // 없다 — 안 고르면 0원으로 계산된다는 걸 명시적으로 안내한다
      // (noZeroOption 플래그, SPEND_GROUP_DETAILS에서 항목별로 직접
      // 표시).
      return `
        <div class="quiz-question-pair">
          <div class="quiz-question-col">
            <p class="quiz-question-label">빈도</p>
            ${quizButtonsHtml(f.id, "freq", f.freqOptions, saved.freq)}
            ${f.noZeroOption ? `<p class="quiz-no-usage-note"><span class="quiz-no-usage-icon" aria-hidden="true">💡</span>이 항목을 이용하지 않는다면 선택하지 않아도 괜찮아요 — 0원으로 계산돼요.</p>` : ""}
          </div>
          <div class="quiz-question-col">
            <p class="quiz-question-label">1회 금액</p>
            ${quizButtonsHtml(f.id, "avg", f.avgOptions, saved.avg)}
          </div>
        </div>`;
    }

    function renderCategoryQuiz(groupId, containerId) {
      const detail = SPEND_GROUP_DETAILS[groupId];
      const saved = draft.spendingDetail?.[groupId] || {};
      const container = $(`#${containerId}`);
      const tabsHtml = `<div class="quiz-tabs" role="tablist">
        ${detail.fields.map((f, i) => `
          <button type="button" class="quiz-tab" role="tab" data-tab="${i}" aria-selected="${i === 0}">${f.label}</button>`).join("")}
      </div>`;
      const panelsHtml = detail.fields.map((f, i) => `
        <div class="quiz-panel" data-panel="${i}" ${i === 0 ? "" : "hidden"}>
          ${quizFieldBodyHtml(f, saved[f.id] || {})}
        </div>`).join("");
      container.innerHTML = tabsHtml + panelsHtml;

      container.querySelectorAll(".quiz-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
          container.querySelectorAll(".quiz-tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
          container.querySelectorAll(".quiz-panel").forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
        });
      });

      // $$는 selector 하나만 받아 항상 document 전체를 검색한다 — 여기서
      // 필요한 건 "이 버튼그룹 안에서만" 선택 해제이므로, DOM 스코프
      // 있는 querySelectorAll을 직접 쓴다. 아니면 페이지 전체 버튼의
      // aria-pressed가 뒤섞여 다른 질문의 답까지 지워진다(식비에서 실제로
      // 이 버그로 마지막에 누른 버튼 하나만 남고 나머지 질문의 선택이
      // 전부 풀려 총액이 0으로 계산됐었다). 탭으로 숨겨진 패널 안 버튼도
      // hidden과 무관하게 aria-pressed/data-value는 그대로 읽히므로,
      // 계산 로직(selectedQuizValue 등)은 손댈 필요가 없다 — 순수
      // 레이아웃 변경이다.
      container.querySelectorAll(".range-grid button").forEach((b) => {
        b.addEventListener("click", () => {
          const grid = b.closest(".range-grid");
          grid.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
          recomputeCategoryFromQuiz(groupId);
        });
      });
    }

    // 버튼으로 고른 구간의 대표값을 v46과 같은 계산식(freq-avg는
    // freq×avg×multiplier, direct는 대표값 그대로, category별 합산 후
    // 한 번만 반올림 — v43 원칙)에 그대로 대입한다. 질문에 하나도 아직
    // 안 답한 필드는 기여분을 0으로 둔다 — freq-avg는 두 질문 중 하나만
    // 골라도 총액이 튀지 않는다(둘 다 답해야 반영).
    function recomputeCategoryFromQuiz(groupId) {
      const detail = SPEND_GROUP_DETAILS[groupId];
      let anyChosen = false;
      const byCategory = {};
      const detailOut = {};
      detail.fields.forEach((f) => {
        if (f.mode === "select") {
          // select는 category가 null이라 byCategory에 아예 안 넣는다 —
          // 그대로 넣으면 draft.spending에 "null" 키가 생긴다(v46에서
          // 겪은 버그). anyChosen도 안 올린다 — 안 그러면 select 하나만
          // 눌러도 아직 안 답한 금액 필드들이 0으로 draft.spending을
          // 덮어써 버린다.
          detailOut[f.id] = { value: selectedQuizRaw(f.id, "sel") };
          return;
        }
        if (f.mode === "direct") {
          const amt = selectedQuizValue(f.id, "amt");
          if (amt != null) anyChosen = true;
          // amt만으로는 "아직 안 답함(기본 0)"과 "0을 실제로 골랐음"을
          // 구분할 수 없다(기타 정기 지출의 "없음"이 값 0인 정식
          // 선택지라서) — answered를 따로 남겨 전체 요약 화면(v51)이
          // 정확히 구분하게 한다.
          detailOut[f.id] = { amt: amt ?? 0, answered: amt != null };
          // divisor는 여행/휴식처럼 "예산은 연 단위로 물었지만 월 지출로
          // 환산해야 하는" 필드에만 있다(기본 1 = 이미 월 단위). 반올림은
          // 여기서 안 하고(v43 원칙) byCategory 합계 전체에 한 번만 한다 —
          // 같은 category(leisure)로 모이는 취미/구독(direct, divisor
          // 없음)과 합친 뒤에 반올림해야 화면 총액과 어긋나지 않는다.
          byCategory[f.category] = (byCategory[f.category] || 0) + (amt ?? 0) / (f.divisor || 1);
          return;
        }
        const freq = selectedQuizValue(f.id, "freq");
        const avg = selectedQuizValue(f.id, "avg");
        if (freq != null || avg != null) anyChosen = true;
        detailOut[f.id] = { freq: freq ?? 0, avg: avg ?? 0 };
        byCategory[f.category] = (byCategory[f.category] || 0) + (freq ?? 0) * (avg ?? 0) * f.multiplier;
      });
      if (!anyChosen) return;
      draft.spendingDetail[groupId] = detailOut;
      Object.entries(byCategory).forEach(([category, won]) => {
        draft.spending[category] = Math.round(won / 10000);
      });
      draft.monthlySpend = spendingTotal(draft.spending);
      $(`#onb-sp-${groupId}`).value = Math.round(draftGroupTotal(SPEND_GROUPS.find((g) => g.id === groupId)));
      updateRunningTotal();
    }

    // "총액을 알고 있어요" 대안(모든 카테고리 화면 공통) — 직접 입력한
    // 총액은 기존 scaleSpending으로 그 그룹의 실카테고리들에 통계 비중대로
    // 나눠 담는다(퀴즈가 아직 없는 카테고리는 이 경로가 유일한 입력
    // 수단이다). 이미 퀴즈로 답한 뒤 총액을 손으로 덮어쓰면, 그 퀴즈
    // 답은 더 이상 이 총액을 설명하지 못하므로 지운다 — v46과 같은 원칙.
    function bindGroupTotalInput(groupId) {
      const g = SPEND_GROUPS.find((x) => x.id === groupId);
      $(`#onb-sp-${groupId}`).addEventListener("input", (e) => {
        const nextGroupTotal = Math.max(0, +e.target.value || 0);
        draft.spending = scaleSpending(
          draft.spending, nextGroupTotal, g.members, PERSONAS[draft.persona]?.spending
        );
        if (draft.spendingDetail?.[groupId]) delete draft.spendingDetail[groupId];
        draft.monthlySpend = spendingTotal(draft.spending);
        updateRunningTotal();
      });
    }
    SPEND_GROUPS.forEach((g) => bindGroupTotalInput(g.id));

    // ---- 7 · 전체 요약 (v51) ----
    // 카테고리 5개 응답을 다 마친 뒤, 연봉으로 넘어가기 전에 하위 항목
    // 단위로 나열해서 보여준다. 값(0)만으로는 "아직 안 고름"과 "0을
    // 실제로 골랐음"을 구분할 수 없어(기타 정기 지출의 "없음"이 값 0인
    // 정식 선택지) direct 모드는 answered 플래그로, freq-avg는 모든
    // 옵션값이 0보다 크다는 성질로, select는 value==null로 구분한다.
    function fieldSummaryLine(f, s) {
      if (f.mode === "select") {
        const label = s ? optionLabelFor(f.options, s.value) : null;
        return `${f.label}: ${label || "아직 답하지 않았어요"}`;
      }
      if (f.mode === "direct") {
        if (!s?.answered) return `${f.label}: 아직 답하지 않았어요`;
        const label = optionLabelFor(f.amtOptions, s.amt);
        const manwon = Math.round(s.amt / (f.divisor || 1) / 10000);
        return `${f.label}: ${label} → 월 약 ${man(manwon)}만원`;
      }
      if (!s?.freq || !s?.avg) return `${f.label}: 아직 답하지 않았어요`;
      const freqLabel = optionLabelFor(f.freqOptions, s.freq);
      const avgLabel = optionLabelFor(f.avgOptions, s.avg);
      const manwon = Math.round((s.freq * s.avg * f.multiplier) / 10000);
      return `${f.label}: ${freqLabel}·1회 ${avgLabel} → 월 약 ${man(manwon)}만원`;
    }

    // 카테고리 자체를 한 번도 안 건드렸으면(총액 직접입력도 안 한 경우
    // 포함) spendingDetail에 그 그룹 키가 아예 없다 — 이때는 하위 항목을
    // 나열하지 않고 "아직 답하지 않았어요"만 보여준다. 카테고리 총액은
    // 두 경우 모두 draftGroupTotal로 계산되므로(퀴즈 미답 시 페르소나
    // 평균값이 그대로 draft.spending에 들어 있다) 항상 표시할 수 있다.
    function renderOnbSummary() {
      const total = spendingTotal(draft.spending);
      let unansweredCount = 0;
      $("#onbSummaryList").innerHTML = SPEND_GROUPS.map((g) => {
        const detail = SPEND_GROUP_DETAILS[g.id];
        const saved = draft.spendingDetail?.[g.id];
        const isUnanswered = !saved;
        if (isUnanswered) unansweredCount++;
        // v52: "아직 답하지 않았어요" 문구가 일반 텍스트와 톤이 같아
        // 눈에 안 띈다는 피드백 — 미답 카테고리만 옅은 경고색 박스(⚠
        // 아이콘 포함)로 감싸고, 답한 카테고리는 기존 차분한 톤을
        // 그대로 둔다.
        const bodyHtml = saved
          ? `<ul class="onb-summary-fields">${detail.fields.map((f) => `<li>${fieldSummaryLine(f, saved[f.id])}</li>`).join("")}</ul>`
          : `<p class="onb-summary-warn-note"><span class="onb-summary-warn-icon" aria-hidden="true">⚠</span>아직 답하지 않았어요 — 평균 기준 기본값이 적용된 상태예요.</p>`;
        return `
          <div class="onb-summary-group${isUnanswered ? " is-unanswered" : ""}">
            <p class="onb-summary-group-title"><span class="legend-swatch" style="background:${SPEND_GROUP_COLOR[g.id]}"></span>${g.name}</p>
            ${bodyHtml}
            <p class="onb-summary-group-total">${g.name} 총액(월): <b>${man(draftGroupTotal(g))}만원</b></p>
          </div>`;
      }).join("");
      const unansweredNote = $("#onbSummaryUnansweredNote");
      unansweredNote.hidden = unansweredCount === 0;
      if (unansweredCount > 0) {
        unansweredNote.textContent = `${unansweredCount}개 카테고리는 아직 답하지 않아 평균값으로 채워졌어요.`;
      }
      $("#onbSummaryGrandTotal").textContent = `전체 월 생활비 합계 · ${man(total)}만원`;
    }

    $("#onbNext2").addEventListener("click", () => showStep(3));
    $("#onbNext3").addEventListener("click", () => showStep(4));
    $("#onbNext4").addEventListener("click", () => showStep(5));
    $("#onbNext5").addEventListener("click", () => showStep(6));
    $("#onbNext6").addEventListener("click", () => showStep(7));
    $("#onbNext7").addEventListener("click", () => showStep(8));

    // ---- 8 · 연봉 (마지막 문항) ----
    $("#onbFinish").addEventListener("click", () => {
      draft.curSalary = Math.max(0, +$("#onbCurSalary").value || 0);
      draft.nextSalary = Math.max(0, +$("#onbNextSalary").value || 0);
      finish(draft);
    });

    // ---- 뒤로가기 (모든 문항 공통) ----
    $$("[data-back]").forEach((b) => {
      b.addEventListener("click", () => showStep(Math.max(0, stepIndex - 1)));
    });

    // ---- 요약 화면 ----
    // 카드 이동은 화살표·점 인디케이터·스와이프만으로 이루어진다(v12 —
    // 카드마다 있던 "다음 카드 보기" 버튼은 이 셋과 중복이라 없앴다).
    // "처음부터 다시 입력하기"는 카드 1·마지막 카드 양쪽, 그리고 헤더 로고
    // 클릭에서도 같은 동작을 하도록 함수로 뽑아 여러 진입점이
    // 공유한다(v9 — 카드뉴스로 바뀌면서 재입력 경로가 어느 카드에도
    // 안 보인다는 버그 리포트에
    // 대응해 진입점을 늘렸다).
    function performRestart() {
      localStorage.removeItem(ONBOARD_KEY);
      setReportVisible(false);
      draft = freshDraft();
      $$("#onbPersonaGrid button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.persona === DEFAULT_PERSONA)));
      wizardView.hidden = false;
      showStep(0);
    }

    // 지금까지 입력한 값을 전부 날리는 되돌릴 수 없는 동작이라 한 번 더
    // 확인한다. window.confirm()은 실행을 동기적으로 막는 네이티브
    // API라, 카카오톡 등 인앱 브라우저에서 그 다이얼로그 자체를 못
    // 띄우거나 화면 밖으로 보내버리면 사용자 눈엔 페이지가 완전히
    // 멈춘 것처럼 보인다 — "처음부터 다시 입력하기 클릭 시 페이지
    // 멈춤" 버그 리포트와 정확히 일치하는 증상이라, confirm() 대신
    // 페이지 안 <dialog>로 바꿨다.
    const restartDialog = $("#restartConfirmDialog");
    function triggerRestart() {
      if (restartDialog && typeof restartDialog.showModal === "function") {
        restartDialog.showModal();
      } else {
        // <dialog>를 못 쓰는 아주 오래된 브라우저를 위한 최후의 대체.
        if (confirm("처음부터 다시 입력할까요? 지금까지 입력한 내용은 모두 사라져요.")) performRestart();
      }
    }
    if (restartDialog) {
      $("#restartConfirmBtn").addEventListener("click", () => {
        restartDialog.close();
        performRestart();
      });
      $("#restartCancelBtn").addEventListener("click", () => restartDialog.close());
      // 카드 안(배경이 아닌 곳)을 눌렀을 때는 안 닫히게, 진짜 바깥
      // 배경을 눌렀을 때만 취소로 처리한다.
      restartDialog.addEventListener("click", (e) => {
        if (e.target === restartDialog) restartDialog.close();
      });
    }
    $$(".deck-restart-link").forEach((b) => b.addEventListener("click", triggerRestart));

    // 헤더 로고는 원래 "#top"으로 스크롤만 했는데, 리포트가 카드뉴스
    // 덱이 되면서 로고를 눌러도 지금 보던 카드 맨 위로 스크롤될 뿐 설문
    // 화면으로 돌아갈 방법이 없어졌다는 버그 리포트가 있었다. 덱이 보이는
    // 동안에는 로고 클릭이 재입력 흐름으로 이어지게 한다 — 설문을 아직
    // 안 끝냈을 때는(덱이 hidden) 기존처럼 그냥 맨 위로 스크롤한다.
    $(".brand").addEventListener("click", (e) => {
      if ($("#deck").hidden) return;
      e.preventDefault();
      triggerRestart();
    });
  }

  function initTheme() {
    const saved = localStorage.getItem("theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    $("#themeToggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const isDark = cur === "dark" ||
        (!cur && matchMedia("(prefers-color-scheme: dark)").matches);
      const next = isDark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
      renderAll();
    });
  }

  /* ══════════════ 숫자 입력 공통 처리 ══════════════
     위저드·리포트·동적으로 생성되는 지출 항목까지 <input type="number">가
     여러 곳에 흩어져 있어, 필드마다 따로 손대는 대신 document 레벨 위임
     하나로 전부 처리한다. 새로 추가되는 입력(예: 지출 세부 항목)도 별도
     배선 없이 자동으로 같은 규칙을 탄다. */
  function setupNumberInputGuards() {
    // 포커스가 가면 기존 값 전체를 선택해 둔다. 그래야 이어서 숫자를
    // 치면 바로 덮어써진다 — 안 그러면 "3600"에 "4200"을 입력했을 때
    // 커서 위치에 그대로 끼어들어 "42003600"처럼 이어붙는다.
    // readonly 필드는 애초에 타이핑이 막혀 있어 선택해도 의미가 없다.
    // select()를 focus 핸들러에서 바로 부르면, 마우스 클릭으로 들어온
    // 경우 브라우저가 곧이어 처리하는 "클릭한 지점에 커서 놓기" 기본
    // 동작이 뒤따라와 선택을 덮어써 버린다(즉 select()가 무효화된다).
    // setTimeout으로 한 틱 미뤄서 그 기본 동작이 끝난 뒤에 선택하면
    // 클릭·Tab 어느 쪽으로 들어와도 항상 전체가 선택된다.
    document.addEventListener("focusin", (e) => {
      if (e.target.matches('input[type="number"]:not([readonly])')) {
        const el = e.target;
        setTimeout(() => el.select(), 0);
      }
    });

    // 필드별 상식적인 상한/하한. 위저드 입력(onbXxx)과 리포트 입력이
    // 결국 같은 값을 다루므로 접두사를 떼고 하나의 규칙으로 묶는다.
    // money: true인 필드는 소수점 없이 정수로만 남긴다 — 퍼센트·기간처럼
    // "돈"이 아닌 숫자(예: 목표 기간)는 그대로 소수 입력을 허용한다.
    // amount: true인 필드는 실제 "금액"(만원 단위)이라 부호·소수점·지수
    // 표기(-, ., e)가 나올 일이 없다 — 아래 beforeinput 가드가 이 필드에
    // 한해 숫자 0~9 외의 입력을 아예 막는다. 목표 기간(년/개월)은 금액이
    // 아니라 기간이라 이 필터에서 제외한다(0 하나만 입력해도 되는 필드라
    // 굳이 막을 이유가 적고, 의미상으로도 "금액"이 아니다).
    const RULES = [
      { test: (id) => id === "monthlySpend", min: 0, max: 5000, label: "월 생활비", money: true, amount: true },
      { test: (id) => id.startsWith("sp-") || id.startsWith("onb-sp-"), min: 0, max: 3000, label: "지출 항목", money: true, amount: true },
      { test: (id) => id === "curSalary" || id === "onbCurSalary" || id === "nextSalary" || id === "onbNextSalary", min: 0, max: 100000, label: "연봉", money: true, amount: true },
      { test: (id) => id === "goalAmount", min: 0, max: 100000, label: "목표 금액", money: true, amount: true },
      { test: (id) => id === "goalCurrent", min: 0, max: 100000, label: "현재 보유 자산", money: true, amount: true },
      { test: (id) => id === "goalYears", min: 0, max: 40, label: "목표 기간(년)", money: true },
      { test: (id) => id === "goalMonths", min: 0, max: 11, label: "목표 기간(개월)", money: true },
      { test: (id) => id === "goalMonthly", min: 0, max: 5000, label: "월 저축 가능액", money: true, amount: true },
      { test: (id) => id === "investAmount", min: 0, max: 100000, label: "투자 금액", money: true, amount: true },
    ];

    // 숫자가 아닌 문자(부호·소수점·"e" 등)는 타이핑이든 붙여넣기든
    // 애초에 입력란에 들어가지 못하게 막는다. beforeinput은 실제로
    // 텍스트가 삽입되기 직전에 뜨므로, 지우기·화살표 이동·전체선택
    // 같은 비삽입 동작(e.data === null)은 건드리지 않는다.
    document.addEventListener("beforeinput", (e) => {
      const input = e.target;
      if (input.tagName !== "INPUT" || input.type !== "number") return;
      const rule = RULES.find((r) => r.test(input.id));
      if (!rule || !rule.amount) return;
      if (e.data != null && /[^0-9]/.test(e.data)) e.preventDefault();
    });
    const guardMsgs = new WeakMap();
    function guardMsgFor(input) {
      let msg = guardMsgs.get(input);
      if (msg) return msg;
      const wrap = input.closest(".input-wrap") || input;
      msg = document.createElement("p");
      msg.className = "err-text field-guard-err";
      msg.hidden = true;
      wrap.insertAdjacentElement("afterend", msg);
      guardMsgs.set(input, msg);
      return msg;
    }

    // input(글자 하나하나)마다 값을 즉시 clamp하면, 자리수가 큰 숫자를
    // 지우고 다시 입력하는 도중(예: "10"만 친 시점)처럼 아직 다 안 친
    // 값이 일시적으로 범위 안팎을 오갈 수 있는데, 그때마다 최댓값으로
    // 스냅해버리면 입력 자체가 막힌다. 그래서 clamp는 필드를 벗어날 때
    // (blur) 딱 한 번만 하고, 타이핑 중에는 경고 문구만 보여준다.
    function rangeInfo(input, rule) {
      if (input.value === "") return null;
      const n = Number(input.value);
      if (Number.isNaN(n)) return null;
      const bounded = Math.min(rule.max, Math.max(rule.min, n));
      return { n, bounded, outOfRange: bounded !== n };
    }

    function updateWarning(input, rule, wrap, msg) {
      const info = rangeInfo(input, rule);
      const outOfRange = !!(info && info.outOfRange);
      msg.hidden = !outOfRange;
      if (outOfRange) {
        msg.textContent =
          `${rule.label}${josa(rule.label, "은", "는")} ${rule.min.toLocaleString("ko-KR")}~${rule.max.toLocaleString("ko-KR")} 사이로 입력할 수 있어요.`;
      }
      if (wrap) wrap.classList.toggle("invalid", outOfRange);
    }

    // 타이핑 중에는 값을 절대 건드리지 않는다 — 범위를 벗어나 있어도
    // 경고 문구만 갱신하고, 입력 자체는 사용자가 친 그대로 둔다.
    document.addEventListener("input", (e) => {
      const input = e.target;
      if (input.tagName !== "INPUT" || input.type !== "number" || input.readOnly) return;
      const rule = RULES.find((r) => r.test(input.id));
      if (!rule) return;
      updateWarning(input, rule, input.closest(".input-wrap"), guardMsgFor(input));
    });

    // 필드를 벗어나는 순간에만 실제로 값을 다듬는다(정수 반올림 + 범위
    // clamp). blur는 버블링하지 않으므로 document 위임은 capture 단계에서
    // 받아야 한다. 값이 바뀌었으면 input 이벤트를 다시 쏴서, 이 필드를
    // 구독 중인 계산 로직(월 투자 가능액↔월 저축 가능액 동기화 등)이
    // 다듬어진 최종값을 반영하게 한다.
    document.addEventListener("blur", (e) => {
      const input = e.target;
      if (input.tagName !== "INPUT" || input.type !== "number" || input.readOnly) return;
      const rule = RULES.find((r) => r.test(input.id));
      if (!rule) return;
      const wrap = input.closest(".input-wrap");
      const msg = guardMsgFor(input);
      const info = rangeInfo(input, rule);
      if (!info) { msg.hidden = true; if (wrap) wrap.classList.remove("invalid"); return; }
      const clamped = rule.money ? Math.round(info.bounded) : info.bounded;
      if (clamped !== info.n) {
        input.value = clamped;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      msg.hidden = true;
      if (wrap) wrap.classList.remove("invalid");
    }, true);
  }

  /* ══════════════ 탭 0 · 내 물가 ══════════════ */
  const groupTotal = (g) => g.members.reduce((sum, id) => sum + (state.spending[id] || 0), 0);

  // v11: 세부 품목별 금액을 접힌 텍스트 목록 대신 가로 막대그래프로
  // 기본 펼쳐서 보여준다 — 금액과 비중이 한눈에 비교되도록.
  // v12: 가로 막대그래프는 비율감이 잘 안 느껴진다는 피드백 — 당시 설문
  // Q2에서 쓰던 conic-gradient 도넛과 같은 방식을 재사용해 비율이 한눈에
  // 비교되게 했다(그 설문 쪽 도넛은 v50에서 텍스트 요약으로 대체됐지만,
  // 여기는 이미 완성된 데이터를 "보여주는" 자리라 그대로 둔다). 범례에
  // 금액과 비중을 함께 표시한다.
  function renderSpendChart() {
    const total = spendingTotal(state.spending);
    let acc = 0;
    const stopObjs = SPEND_GROUPS.map((g) => {
      const weight = total > 0 ? groupTotal(g) / total : 0;
      const from = acc * 100, to = (acc + weight) * 100;
      acc += weight;
      return { color: SPEND_GROUP_COLOR[g.id], from, to };
    });
    $("#spendDonut").style.background = total > 0
      ? `conic-gradient(${stopObjs.map((s) => `${s.color} ${s.from.toFixed(2)}% ${s.to.toFixed(2)}%`).join(",")})`
      : "var(--surface-sunk)";
    if (total > 0) $("#spendDonut").dataset.donutStops = JSON.stringify(stopObjs);
    else delete $("#spendDonut").dataset.donutStops;
    $("#spendDonutCenter").innerHTML =
      `<div style="font-size:.7rem;color:var(--text-muted)">총 생활비</div>
       <div style="font-size:1.3rem;font-weight:800">${man(total)}만원</div>`;
    $("#spendLegend").innerHTML = SPEND_GROUPS.map((g) => {
      const amount = groupTotal(g);
      const weight = total > 0 ? (amount / total) * 100 : 0;
      return `<span class="legend-item"><span class="legend-swatch" style="background:${SPEND_GROUP_COLOR[g.id]}"></span>
        ${g.name} ${man(amount)}만원 (${weight.toFixed(0)}%)</span>`;
    }).join("");
  }

  function syncSpendingFields(syncTotal = true) {
    renderSpendChart();
    if (syncTotal) {
      $("#monthlySpend").value = Math.round(spendingTotal(state.spending));
    }
  }

  function applyPersona(key) {
    const p = PERSONAS[key];
    if (!p) return;
    state.persona = key;
    state.spending = roundSpending(p.spending);
    $("#personaLabel").textContent = p.label;
    syncSpendingFields();
    renderMine();
  }

  function setupMineTab() {
    const cats = state.cpi.categories || [];
    if (!cats.length) {
      // 이 시점엔 덱이 아직 hidden이라(설문 전) 그 안에 넣으면 아무도
      // 못 본다 — boot()의 데이터 로드 실패 처리와 같은 자리(main 맨 위)에
      // 바로 보이게 띄운다.
      document.querySelector("main").insertAdjacentHTML("afterbegin",
        `<div class="load-error">품목별 물가 데이터가 없습니다. 파이프라인을 다시 실행해 주세요.</div>`);
      return;
    }

    renderSpendChart();

    // 이 탭의 지출 입력은 이제 전부 readonly라 사용자가 직접 타이핑해서
    // "input" 이벤트를 쏠 일이 없다. 그래도 이 리스너는 남겨 둔다 —
    // applyOnboardProfile이 setInputAndFire("#monthlySpend", ...)로
    // 설문에서 입력한 총액을 프로그램적으로 밀어넣을 때, 그 총액에 맞게
    // 지출 비중을 재조정(scaleSpending)하는 유일한 통로이기 때문이다.
    $("#monthlySpend").addEventListener("input", (e) => {
      const nextTotal = Math.max(0, +e.target.value || 0);
      const base = spendingTotal(state.spending) > 0
        ? state.spending
        : (state.persona ? PERSONAS[state.persona].spending : PERSONAS[DEFAULT_PERSONA].spending);
      state.spending = scaleSpending(base, nextTotal);
      syncSpendingFields(false);
      renderMine();
    });

    syncSpendingFields();
    $("#personaLabel").textContent = (PERSONAS[state.persona] || PERSONAS[DEFAULT_PERSONA]).label;
  }

  /* "비중 × 상승률을 다 더한다"는 말은 식으로만 보면 안 와닿는다.
     그래서 내가 지금 넣은 숫자로 실제 계산을 한 줄씩 따라가게 보여준다.
     기여도가 가장 큰 항목 하나를 예로 들고, 마지막에 합이 내 물가라는
     것까지 이어 준다. */
  function renderContribMath(grouped, result, official) {
    const box = $("#contribMath");
    if (!box) return;
    const top = grouped.filter((g) => g.amount > 0)[0];
    if (!top) { box.innerHTML = ""; return; }

    const sum = grouped.reduce((s, g) => s + g.contribution, 0);
    const diff = result.rate - official;
    const verdict = Math.abs(diff) < 0.05
      ? "그래서 내 물가는 평균과 거의 같습니다."
      : `그래서 내 물가가 평균보다 <b>${Math.abs(diff).toFixed(1)}%p ${diff > 0 ? "높습니다" : "낮습니다"}</b>.`;

    box.innerHTML = `
      <p class="calc-step"><span class="calc-no">1</span>
        <b>${top.name}</b>에 월 ${man(top.amount)}만원 — 생활비의
        <b>${(top.weight * 100).toFixed(0)}%</b>입니다.</p>
      <p class="calc-step"><span class="calc-no">2</span>
        그 ${top.name} 물가가 1년 새 <b>${top.rate >= 0 ? "+" : ""}${top.rate.toFixed(1)}%</b> 올랐습니다.</p>
      <p class="calc-step"><span class="calc-no">3</span>
        둘을 곱하면 ${(top.weight * 100).toFixed(0)}% × ${top.rate.toFixed(1)}% =
        <b>${top.contribution >= 0 ? "+" : ""}${top.contribution.toFixed(2)}%p</b> —
        ${top.name} 하나가 내 물가를 이만큼 밀어올렸습니다.</p>
      <p class="calc-step calc-last"><span class="calc-no">=</span>
        나머지 항목도 같은 방식으로 더하면 <b>${sum >= 0 ? "+" : ""}${sum.toFixed(1)}%</b>,
        이게 내 물가입니다. ${verdict}</p>`;
  }

  // v20 항목6: "내 물가" 카드에 공식 물가의 과거 흐름 + 추세 예측선을
  // 덧붙인다. 실제 값(state.cpi.yoy, 10년치)은 그대로 실선으로 다
  // 보여주고, 예측은 최근 3년 추세(E.forecastLinear)만 따로 점선으로
  // 이어 붙인다 — 10년 전체로 추세를 맞추면 코로나 시기 등 지금과
  // 다른 물가 국면이 섞여 최근 흐름을 제대로 반영하지 못한다.
  function renderInflationForecast() {
    const card = $("#inflationForecastCard");
    if (!card) return;
    if (!state.cpi || !state.cpi.yoy) { card.hidden = true; return; }
    const result = E.forecastAR2(state.cpi.yoy, { historyMonths: 36, forecastMonths: 12 });
    if (!result) { card.hidden = true; return; }
    card.hidden = false;

    const allMonths = Object.keys(state.cpi.yoy).sort();
    const historyPoints = allMonths.map((m, i) => ({ x: i, y: state.cpi.yoy[m], meta: E.monthLabel(m) }));
    const lastIdx = historyPoints.length - 1;
    const forecastPoints = [
      { x: lastIdx, y: historyPoints[lastIdx].y, meta: historyPoints[lastIdx].meta },
      ...result.forecast.map((f, i) => ({ x: lastIdx + 1 + i, y: f.value, meta: `${E.monthLabel(f.month)} (예측)` })),
    ];

    const xLabels = [];
    allMonths.forEach((m, i) => { if (m.endsWith("-01")) xLabels.push({ at: i, text: m.slice(0, 4) }); });
    result.forecast.forEach((f, i) => {
      if (f.month.endsWith("-01")) xLabels.push({ at: lastIdx + 1 + i, text: f.month.slice(0, 4) });
    });

    lineChart($("#forecastChart"), {
      series: [
        { id: "history", label: "실제 물가상승률", color: "var(--brand)", points: historyPoints },
        { id: "forecast", label: "예측(최근 3년 추세)", color: "var(--warning)", dashed: true, points: forecastPoints },
      ],
      xLabels,
      yFormat: (v) => `${v.toFixed(1)}%`,
    });

    $("#forecastLegend").innerHTML =
      `<span class="legend-item"><span class="legend-swatch" style="background:var(--brand)"></span>실제 물가상승률</span>
       <span class="legend-item"><span class="legend-swatch" style="background:var(--warning)"></span>예측 · 최근 3년으로 계산 (실제와 다를 수 있음)</span>`;
  }

  // v48: AI 해설(/api/insight, v38~v45)을 걷어냈다 — 모델 만료·API 키·
  // 할당량 초과가 반복돼 안정성 문제가 있었고, v47로 설문이 세분화되며
  // 규칙 기반으로도 충분히 구체적인 문구를 만들 수 있게 됐다. 이 자리
  // (카드1 처방전/카드3 물가비교·절약팁/카드6 시나리오)에 있던 로딩·
  // 디바운스·fetch 로직은 전부 지웠고, v47 데이터를 활용한 규칙 기반
  // 문구로 대체한다(아래 renderSavingTips 등 참고). api/insight.mjs
  // 자체는 당장 지우지 않았다 — 프론트엔드가 더는 안 부르는 것만
  // 확인됐다.

  function renderMine() {
    const cats = state.cpi.categories || [];
    if (!cats.length) return;

    const spending = state.spending;

    const result = E.personalInflation(spending, cats);
    const official = state.cpi.latest.yoy;

    if (!result) {
      state.personalRate = null;
      $("#mineVerdict").className = "verdict";
      $("#mineVerdict").textContent = "지출을 하나 이상 입력해 주세요.";
      $("#officialRateBig").textContent = "—";
      $("#myRateBig").textContent = "—";
      $("#myRateDiff").textContent = "—";
      $("#contribRank").innerHTML = "";
      $("#mineTips").innerHTML = "";
      $("#contribChart").innerHTML = `<p class="skeleton">월 생활비를 입력하면 항목별 기여도를 보여드립니다.</p>`;
      $("#contribMath").innerHTML = "";
      $("#mineSrc").textContent = "";
      return;
    }

    state.personalRate = result.rate;
    // 화면(officialRateBig/myRateBig)이 1자리로 반올림해 보여주므로,
    // 차이도 그 반올림된 자리수 기준으로 구한다 — 원본 정밀 차이를 따로
    // 반올림하면 화면엔 "2.8% / 2.8%"로 같아 보이는데 차이만 "+0.1%p"로
    // 뜨는 불일치가 생긴다(실제로 발견된 버그).
    const diff = displayDiff(result.rate, official, 1);

    // 기여도 분해 — 헤드라인이 "무엇 때문에" 비싼지 가리키는 항목도
    // 이 그룹 랭킹(아래 "내 물가를 밀어올린 범인"과 같은 5개 그룹) 1위를
    // 그대로 쓴다 — 카드 두 개가 서로 다른 항목을 "1위"라고 하면 안 되니까.
    const grouped = E.aggregateByGroup(result.contributions, SPEND_GROUPS)
      .sort((a, b) => b.contribution - a.contribution);
    const ranked = grouped.filter((g) => g.amount > 0);

    // "비싸게/저렴하게 산다"는 체감 결론만 있으면 무엇과 비교한 건지
    // 애매하다는 피드백 — 가장 크게 기여한 항목의 실제 물가상승률을
    // 공식 평균과 나란히 병기해서, 비교 기준이 문장 하나로 바로
    // 보이게 한다(diff의 부호와 무관하게 항상 실제 수치만 말하므로
    // "그래서 더/덜 올랐다"처럼 어긋날 수 있는 단정은 하지 않는다).
    // v12: "얼마나 비싸게 살고 있나" 카드와 "범인" 카드를 하나로
    // 합치면서, 예전에 범인 카드 쪽에서 따로 보여주던 "한 달에 약
    // X만원 더/덜 나가요" 문장이 이 헤드라인과 같은 항목(1위)을 두 번
    // 말하는 중복이 됐다 — 그 금액 정보만 이 문장에 흡수하고 별도
    // 문단은 없앴다.
    const v = $("#mineVerdict");
    const cause = ranked[0];
    const monthlyExtra = cause ? cause.amount * (cause.rate / 100) : 0;
    if (diff === 0) {
      v.className = "verdict";
      // 차이가 작다는 사실만 확인됐을 뿐, 그 이유가 "지출 구성이 평균과
      // 비슷해서"인지는 확인한 적이 없다. 실제로 의류·신발에만 100%를
      // 써도 그 품목 물가가 2.79%로 공식과 같아 이 갈래로 들어온다 —
      // 구성은 극단적인데 "평균과 비슷한 구성"이라고 말하게 된다.
      // 다른 두 갈래처럼 실제 수치만 말하고 원인은 단정하지 않는다.
      v.innerHTML = cause
        ? `당신의 체감 물가는 <b>전국 평균과 거의 같아요.</b>
           비중이 가장 큰 건 <b>${cause.name}</b>(${(cause.weight * 100).toFixed(0)}%)이고,
           이 품목 물가는 <b>${cause.rate.toFixed(1)}%</b>예요 (전체 평균 ${official.toFixed(1)}%).`
        : `당신의 체감 물가는 <b>전국 평균과 거의 같아요.</b>`;
    } else if (diff > 0) {
      v.className = "verdict warn";
      v.innerHTML = cause
        ? `당신은 다른 사람들보다 <b>더 비싸게 살고 있어요!</b>
           가장 크게 영향을 준 <b>${cause.name}</b> 물가가 <b>${cause.rate.toFixed(1)}%</b>
           올랐어요 (전체 평균 ${official.toFixed(1)}%, 한 달에 약 ${man(Math.abs(monthlyExtra))}만원 더 나가요).`
        : `당신은 다른 사람들보다 <b>더 비싸게 살고 있어요!</b>`;
    } else {
      v.className = "verdict";
      v.innerHTML = cause
        ? `당신은 다른 사람들보다 <b>더 저렴하게 살고 있어요!</b>
           지출 비중이 가장 큰 <b>${cause.name}</b> 물가는 <b>${cause.rate.toFixed(1)}%</b>예요
           (전체 평균 ${official.toFixed(1)}%).`
        : `당신은 다른 사람들보다 <b>더 저렴하게 살고 있어요!</b>`;
    }
    // v13: "공식 물가 2.8% · 내 물가 2.9%"가 작은 보조 텍스트라 헤드라인
    // 문장에 묻혀 보인다는 피드백 — 카드의 시각적 중심이 되도록 큰
    // 숫자로 따로 뺐다(.price-compare, 아이스 아메리카노 카드를 없앤
    // 자리). 헤드라인 문장은 그대로 아래에 이어져 "왜"를 설명한다.
    $("#officialRateBig").textContent = `${official.toFixed(1)}%`;
    $("#myRateBig").textContent = `${result.rate.toFixed(1)}%`;
    $("#myRateDiff").textContent = `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}%p`;
    $("#myRateDiff").className = `price-compare-diff ${diff > 0 ? "is-warn" : diff < 0 ? "is-good" : ""}`;

    // 그래프는 12개 실카테고리(top)를 5개 그룹(grouped/ranked, 위에서
    // 이미 계산)으로 묶어서 보여준다(품목이 너무 많아 읽기 힘들다는
    // 피드백). 품목이 전체 평균보다 빨리 오르는지는 막대 색(오렌지/
    // 그린)만으로 표시했었다. 색약 사용자를 위해 방향 기호(▲/▼)도
    // 라벨에 같이 붙인다.
    const rankRow = (g, i) => `
      <li class="rank-row">
        <span class="rank-no">${i + 1}위</span>
        <span class="rank-name">${g.name}</span>
      </li>`;
    $("#contribRank").innerHTML = ranked.map((g, i) => rankRow(g, i)).join("");
    $("#mineTips").innerHTML = cause ? tipBoxHtml(cause.id, cause.name) : "";

    Charts.contributionChart($("#contribChart"),
      grouped.filter((g) => g.amount > 0).map((g) => ({
        ...g, examples: (SPEND_GROUPS.find((s) => s.id === g.id) || {}).examples,
        hot: g.rate >= official, color: g.rate >= official ? "var(--series-2)" : "var(--series-3)",
      })));
    renderContribMath(grouped, result, official);
    $("#mineSrc").textContent =
      `OECD 한국 소비자물가 COICOP 12분류 · ${result.month} 기준 · 주 1회 수집 스냅샷`;
  }

  /* ══════════════ 탭 1 · 실질임금 진단 ══════════════ */
  function setupGapTab() {
    ["#curSalary", "#nextSalary"].forEach((sel) => {
      $(sel).addEventListener("input", () => renderGap());
    });
  }

  function readGapInputs() {
    const cur = Math.max(0, +$("#curSalary").value || 0);
    const next = Math.max(0, +$("#nextSalary").value || 0);
    const err = $("#salaryErr");
    if (cur === 0) {
      err.textContent = "현재 연봉을 입력해 주세요.";
      err.hidden = false;
    } else if (next < cur * 0.5) {
      err.textContent = "내년 연봉이 현재의 절반 미만입니다. 값을 확인해 주세요.";
      err.hidden = false;
    } else {
      err.hidden = true;
    }
    return { cur, next, valid: cur > 0 };
  }

  // 부족분을 "며칠 더 일해야 하는가"로 환산한다.
  // 만원 단위 숫자는 잘 안 와닿지만 근무일수는 바로 체감된다.
  const WORKDAYS_PER_YEAR = 250;  // 주 5일 · 연차·공휴일 제외한 통상 근무일
  function workdayStat(nextSalary, d) {
    if (nextSalary <= 0) return "";
    const perDay = nextSalary / WORKDAYS_PER_YEAR;
    const days = Math.abs(d.gap) / perDay;
    if (d.beatsInflation) {
      return `<div class="stat is-good"><span class="k">벌어둔 시간</span>
        <span class="v">${days.toFixed(1)}일</span>
        <span class="s">그만큼 덜 일해도 작년 수준</span></div>`;
    }
    return `<div class="stat is-bad"><span class="k">더 일해야 하는 날</span>
      <span class="v">${days.toFixed(1)}일</span>
      <span class="s">작년과 같은 생활을 하려면</span></div>`;
  }

  function renderGap() {
    const { cur, next, valid } = readGapInputs();

    // 연봉이 0이면 그냥 return 하던 탓에 차트 자리가 빈 칸으로 남았다.
    // '내 물가' 탭처럼 왜 비어 있는지 알려 준다. 안내 없이 비어 있으면
    // 사용자는 고장난 걸로 읽는다.
    if (!valid) {
      const guide = "현재 연봉을 입력하면 물가와 비교해 보여드립니다.";
      const trendTitleEl = $("#trendTitle");
      if (trendTitleEl) trendTitleEl.textContent = "격차는 해마다 벌어집니다";
      $("#trendChart").innerHTML = `<p class="skeleton">현재 연봉을 입력하면 격차가 어떻게 벌어지는지 계산합니다.</p>`;
      $("#trendLegend").innerHTML = "";
      $("#gapStats").innerHTML = "";
      $("#negoStats").innerHTML = "";
      $("#negoChart").innerHTML = "";
      $("#negoPrintTable tbody").innerHTML = "";
      $("#gapVerdict").className = "verdict";
      $("#gapVerdict").textContent = guide;
      $("#trendVerdict").className = "verdict";
      $("#trendVerdict").textContent = guide;
      $("#negoVerdict").className = "verdict";
      $("#negoVerdict").textContent = guide;
      return;
    }

    const inflationPct = diagnosticInflation();
    const d = E.diagnose({ curSalary: cur, nextSalary: next, inflationPct });
    // gapStats·gapVerdict가 "내년 연봉"·"물가 유지선"을 man()으로 반올림해
    // 나란히 보여준 뒤 그 "차이"까지 문장에 다시 쓰므로, d.gap(원본 정밀
    // 차이)을 따로 반올림하지 않고 화면에 찍히는 반올림 값 기준으로
    // 다시 구한다(부호 규약은 d.gap과 동일: +면 부족, -면 여유).
    const gapDisplay = displayDiff(d.requiredSalary, next, 0);

    // KPI
    const gapCls = d.beatsInflation ? "is-good" : (d.gap > cur * 0.03 ? "is-bad" : "is-warn");
    $("#gapStats").innerHTML = `
      <div class="stat"><span class="k">명목 인상액</span>
        <span class="v">${man(d.nominalRaise)}만원</span>
        <span class="s">${d.nominalRatePct >= 0 ? "+" : ""}${d.nominalRatePct.toFixed(1)}%</span></div>
      <div class="stat ${d.realRatePct >= 0 ? "is-good" : "is-bad"}"><span class="k">실질 인상률</span>
        <span class="v">${d.realRatePct >= 0 ? "+" : ""}${d.realRatePct.toFixed(1)}%</span>
        <span class="s">명목 − 물가</span></div>
      <div class="stat ${gapCls}"><span class="k">${d.beatsInflation ? "연간 여유" : "연간 부족분"}</span>
        <span class="v">${man(Math.abs(gapDisplay))}만원</span></div>
      <div class="stat"><span class="k">내년 연봉으로 실제 살 수 있는 만큼</span>
        <span class="v">${man(d.realValue)}만원</span>
        <span class="s">올해 물가 기준</span></div>
      ${workdayStat(next, d)}`;

    const v = $("#gapVerdict");
    if (d.beatsInflation) {
      v.className = "verdict";
      v.innerHTML = `내년 연봉 <b>${man(next)}만원</b>은 물가 유지선(${man(d.requiredSalary)}만원)을
        <b>${man(-gapDisplay)}만원 넘어섭니다.</b> 실질 소득이 늘어나는 구간입니다.`;
    } else {
      const days = next > 0 ? d.gap / (next / WORKDAYS_PER_YEAR) : 0;
      v.className = d.gap > cur * 0.03 ? "verdict bad" : "verdict warn";
      v.innerHTML = `물가를 따라가려면 <b>${man(d.requiredSalary)}만원</b>이 필요한데
        내년 연봉은 ${man(next)}만원입니다. 연 <b>${man(gapDisplay)}만원</b>이 부족합니다.
        <b>작년과 같은 생활을 하려면 ${days.toFixed(1)}일을 더 일해야 하는 셈입니다.</b>`;
    }

    renderTrend(cur, next, d, inflationPct);
    renderNegotiation(cur, d, inflationPct);
  }

  // 인상률과 물가가 이 차이(%p) 안에 있으면 "비슷한 속도"로 본다 —
  // 딱 0으로 가르면 0.01%p 차이로도 "개선"/"악화"로 갈려 사소한
  // 반올림 차이가 과장된 제목을 만든다.
  const TREND_SIMILAR_THRESHOLD_PP = 0.2;

  /* 격차는 해마다 벌어진다 — 명목 인상률과 물가가 유지될 때의 두 곡선.
     (bumyong 프로토타입의 연도별 추이 관점을 실데이터 기준으로 다시 만듦)
     v28: 제목을 "격차는 해마다 벌어집니다"로 고정해 뒀더니, 연봉이
     물가를 이기는 케이스에서도 실제로는 좁혀지는 그래프에 "벌어진다"는
     제목이 붙는 모순이 있었다 — 인상률 vs 물가 상승률 비교로 제목을
     동적으로 바꾼다. 이 카드의 핵심 숫자(격차)도 명목 원 차액이 아니라
     "물가 유지선"(오늘과 같은 구매력을 유지하는 데 필요한 연봉) 대비
     차이라 실질 구매력 비교라는 점을 문구에 명시한다. */
  function renderTrend(cur, next, d, inflationPct) {
    const YEARS = 10;
    const raise = cur > 0 ? (next - cur) / cur : 0;
    const infl = inflationPct / 100;

    const nominal = [], required = [];
    for (let y = 0; y <= YEARS; y++) {
      nominal.push({ x: y, y: cur * Math.pow(1 + raise, y), meta: `${y}년차` });
      required.push({ x: y, y: cur * Math.pow(1 + infl, y), meta: `${y}년차` });
    }

    const labels = [];
    for (let y = 0; y <= YEARS; y += 2) labels.push({ at: y, text: `${y}년` });

    lineChart($("#trendChart"), {
      series: [
        { id: "nominal", label: "내 연봉", color: "var(--series-1)", points: nominal },
        { id: "required", label: "물가 유지선", color: "var(--reference)", dashed: true, points: required },
      ],
      xLabels: labels,
      yFormat: (v) => `${man(v / 1000) / 10}억`,
    });

    $("#trendLegend").innerHTML =
      `<span class="legend-item"><span class="legend-swatch" style="background:var(--series-1)"></span>내 연봉 (인상률 ${(raise * 100).toFixed(1)}%)</span>
       <span class="legend-item"><span class="legend-swatch" style="background:var(--reference)"></span>물가 유지선 (${inflationPct.toFixed(1)}%)</span>`;

    const diffPp = raise * 100 - inflationPct;
    const title = $("#trendTitle");
    if (title) {
      title.textContent = diffPp > TREND_SIMILAR_THRESHOLD_PP
        ? "지금 추세라면 구매력이 개선됩니다"
        : diffPp < -TREND_SIMILAR_THRESHOLD_PP
          ? "지금 추세라면 구매력이 점점 줄어듭니다"
          : "연봉이 물가와 비슷한 속도로 오르고 있습니다";
    }

    const endGap = required[YEARS].y - nominal[YEARS].y;
    const v = $("#trendVerdict");
    if (endGap <= 0) {
      v.className = "verdict";
      v.innerHTML = `인상률이 물가를 앞서고 있어 격차가 <b>벌어지지 않습니다.</b>
        10년 뒤에는 실질 구매력 기준으로 오히려 <b>${man(-endGap)}만원</b> 더 여유로워집니다.`;
      $("#trendTips").innerHTML = "";
    } else {
      v.className = "verdict bad";
      v.innerHTML = `지금 조건이 유지되면 10년 뒤 실질 구매력 기준 격차는 <b>연 ${man(endGap)}만원</b>까지 벌어집니다.
        매년 <b>${(inflationPct - d.nominalRatePct).toFixed(1)}포인트</b>씩 밀리는 게 복리로 쌓인 결과입니다.`;
      // 격차가 벌어지는 쪽일 때만 "그럼 어떻게 줄이나"가 의미 있다 —
      // 카드3·시나리오 계산과 같은 팁 라이브러리·판별 기준
      // (SPEND_TIPS, rankedAboveAverageCauses 기반 topSpendingCause)을
      // 그대로 재사용한다.
      const cause = topSpendingCause();
      $("#trendTips").innerHTML = cause
        ? tipBoxHtml(cause.id, cause.name, `이 격차를 줄이려면 — ${cause.name} 지출부터 살펴보세요`)
        : "";
    }
  }

  /* 성향 3개를 나란히 놓는다. 지금까지는 고른 것 하나만 보여서
     "안정형이 균형형과 뭐가 다른지"를 눌러 가며 비교해야 했다.
     변동성 %는 안 와닿으므로 "나쁜 해에는 이만큼"으로 번역해 함께 둔다. */
  function renderRiskCompare() {
    const box = $("#riskCompare");
    if (!box) return;
    const active = state.customWeights ? null : state.goalRisk;

    const rows = Object.keys(state.market.portfolios).map((key) => {
      const p = E.planOf(state.market, key);
      return { key, p, bad: E.badYear(p.expected_return, p.expected_volatility) };
    });

    box.innerHTML = `
      <div class="mix-head-row">
        <span></span><span>기대수익</span><span>나쁜 해엔</span><span class="mix-desc-col"></span>
      </div>
      ${rows.map(({ key, p, bad }) => `
        <button type="button" class="mix-row-btn${key === active ? " is-active" : ""}"
                data-mix-risk="${key}">
          <span class="mix-label">${p.label}</span>
          <span class="mix-num good">${pct(p.expected_return)}</span>
          <span class="mix-num bad">${signPct(bad)}</span>
          <span class="mix-desc-col">${p.desc}</span>
        </button>`).join("")}
      <p class="field-note mix-foot">
        “나쁜 해엔”은 변동성으로 추정한 대략적인 하락 폭입니다. 실제로는 더 깊을 수 있어요.
      </p>`;

    $$("#riskCompare [data-mix-risk]").forEach((b) => {
      b.addEventListener("click", () => {
        state.goalRisk = b.dataset.mixRisk;
        state.customWeights = null;          // 프리셋을 고르면 직접 조정은 해제
        renderAll();
      });
    });
  }

  /* 비중을 직접 맞추는 슬라이더. '내 물가'의 지출 슬라이더와 같은 방식이라
     하나를 올리면 나머지가 비례해서 줄고 합은 항상 100%가 된다. */
  function renderMixTuner(plan) {
    const box = $("#mixFields");
    if (!box || !plan) return;

    const assets = state.market.assets;
    const weights = Object.fromEntries(assets.map((a) => [a.id, plan.weights[a.id] || 0]));

    box.innerHTML = assets.map((a) => {
      const w = weights[a.id] || 0;
      return `<div class="mix-row" style="--slider-color:${colorOf(a.id)}">
        <div class="mix-head">
          <span class="legend-swatch" style="background:${colorOf(a.id)}"></span>
          <span class="mix-name">${a.name}</span>
          <span class="rate-chip ${a.cagr >= 0.05 ? "rate-hot" : a.cagr <= 0 ? "rate-cool" : "rate-mild"}">${signPct(a.cagr)}</span>
          <span class="spacer"></span>
          <span class="mix-pct">${(w * 100).toFixed(0)}%</span>
        </div>
        <input type="range" id="mix-${a.id}" min="0" max="100" step="1"
               value="${(w * 100).toFixed(0)}" aria-label="${a.name} 비중">
      </div>`;
    }).join("");

    assets.forEach((a) => {
      const el = $(`#mix-${a.id}`);
      if (!el) return;
      el.addEventListener("input", (e) => {
        const next = { ...(state.customWeights || weights) };
        const target = Math.max(0, Math.min(1, (+e.target.value || 0) / 100));
        const others = Object.keys(next).filter((k) => k !== a.id);
        const otherSum = others.reduce((s, k) => s + (next[k] || 0), 0);
        const remaining = 1 - target;
        if (otherSum <= 0) {
          others.forEach((k) => { next[k] = remaining / others.length; });
        } else {
          others.forEach((k) => { next[k] = (next[k] || 0) / otherSum * remaining; });
        }
        next[a.id] = target;
        state.customWeights = next;
        renderAll();
      });
    });

    $("#mixReset").hidden = !state.customWeights;
  }

  function renderPlan(monthly, plan, annualGain) {
    if (!plan) return;

    renderRiskCompare();
    renderMixTuner(plan);

    // 도넛 (conic-gradient — sangmi 방식)
    let acc = 0;
    const stops = plan.items.map((it) => {
      const from = acc * 100, to = (acc + it.weight) * 100;
      acc += it.weight;
      return `${colorOf(it.id)} ${from.toFixed(2)}% ${to.toFixed(2)}%`;
    });
    $("#donut").style.background = `conic-gradient(${stops.join(",")})`;
    $("#donutCenter").innerHTML =
      `<div style="font-size:.7rem;color:var(--text-muted)">기대수익률</div>
       <div style="font-size:1.3rem;font-weight:800">${pct(plan.expected_return)}</div>
       <div style="font-size:.68rem;color:var(--text-muted)">연 ${plan.label}</div>`;

    const real = plan.expected_return - state.inflation / 100;
    $("#planStats").innerHTML = `
      <div class="stat"><span class="k">기대 수익률</span><span class="v">${pct(plan.expected_return)}</span>
        <span class="s">실제 10년 실현 수익 가중평균</span></div>
      <div class="stat ${real >= 0 ? "is-good" : "is-bad"}"><span class="k">실질 수익률</span>
        <span class="v">${signPct(real)}</span><span class="s">물가 ${state.inflation.toFixed(1)}% 차감</span></div>
      <div class="stat"><span class="k">예상 연 수익</span><span class="v">${man(annualGain)}만원</span>
        <span class="s">월 ${man(monthly)}만원 투자 시</span></div>
      <div class="stat"><span class="k">예상 변동성</span><span class="v">${pct(plan.expected_volatility)}</span>
        <span class="s">연 표준편차</span></div>`;

    $("#planLegend").innerHTML = plan.items.map((it) =>
      `<span class="legend-item"><span class="legend-swatch" style="background:${colorOf(it.id)}"></span>
       ${it.asset ? it.asset.name : it.id} ${(it.weight * 100).toFixed(0)}%</span>`).join("");

    $("#planTable").innerHTML = plan.items.map((it) => {
      const a = it.asset;
      if (!a) return "";
      const mdd = a.mdd ? signPct(a.mdd.depth) : "—";
      // 예금은 가격이 아니라 금리 기반이라 근거를 따로 밝힌다.
      const flag = a.id === "cash"
        ? ` <span class="risk-badge risk-low">금리 기준</span>`
        : "";
      return `<tr>
        <td><span class="legend-swatch" style="background:${colorOf(it.id)};display:inline-block;margin-right:.4rem"></span>${a.name}${flag}</td>
        <td class="num">${(it.weight * 100).toFixed(0)}%</td>
        <td class="num">${signPct(a.cagr)}</td>
        <td class="num">${a.volatility ? pct(a.volatility) : "—"}</td>
        <td class="num">${mdd}</td></tr>`;
    }).join("");

    const src = state.market.assets.find((a) => a.id === "kodex200");
    $("#planSrc").textContent =
      `실제 월별 가격 ${src ? src.range[0] : ""}~${src ? src.range[1] : ""} 기준` +
      `${src?.last_month_partial ? ` · ${src.last_month}은 수집 시점 가격` : ""} · ` +
      `예금은 OECD 한국 3개월 은행간금리 (최근 ${state.market.deposit_rate_latest}%)`;
  }

  function renderNegotiation(cur, d, inflationPct) {
    const n = E.negotiate({
      curSalary: cur, inflationPct,
      offeredRatePct: d.nominalRatePct, desiredRealRatePct: 1,
    });
    const defendAmount = cur * (inflationPct / 100);
    const offeredAmount = cur * (d.nominalRatePct / 100);
    const targetAmount = n.targetSalary - cur;
    const achieved = n.shortfallPp <= 0;

    // v13: 세 금액이 숫자 카드로만 나열돼 있어 한눈에 비교가 안
    // 된다는 피드백 — 카드 4의 연봉 비교(barChart)와 같은 컴포넌트를
    // 재사용해 나란히 놓고, "제안받은 인상액" 막대 색으로 목표
    // 달성 여부를 바로 보여준다(과거 "차이 — 달성" 카드가 하던 역할).
    barChart($("#negoChart"), [
      { label: "물가 관리 최소", value: defendAmount, color: "var(--baseline)" },
      { label: "실질 +1% 목표", value: targetAmount, color: "var(--brand)" },
      {
        label: "제안받은 인상액", value: offeredAmount,
        color: achieved ? "var(--good)" : "var(--critical)",
        sub: achieved ? "목표 달성" : "목표 미달", subColor: achieved ? "var(--good-text)" : "var(--critical-text)",
      },
    ]);

    $("#negoStats").innerHTML = `
      <div class="stat"><span class="k">물가 관리 최소 인상액</span><span class="v">${man(defendAmount)}만원</span>
        <span class="s">최소 기준선 (${inflationPct.toFixed(1)}%)</span></div>
      <div class="stat"><span class="k">실질 +1% 목표 인상액</span><span class="v">${man(targetAmount)}만원</span>
        <span class="s">목표 연봉 ${man(n.targetSalary)}만원 (${n.targetRatePct.toFixed(1)}%)</span></div>
      <div class="stat"><span class="k">제안받은 인상액</span><span class="v">${man(offeredAmount)}만원</span>
        <span class="s">설문에서 입력한 내년 연봉 기준 (${d.nominalRatePct.toFixed(1)}%)</span></div>`;

    // 인쇄용 표 — 화면의 막대그래프(#negoChart)는 정적 인쇄물에서 축 없이
    // 크기만으로는 세 값을 비교하기 어려워, 같은 값을 표로도 병기한다.
    const negoTableBody = $("#negoPrintTable tbody");
    if (negoTableBody) {
      negoTableBody.innerHTML = `
        <tr><td>물가 관리 최소 인상액</td><td class="num">${man(defendAmount)}만원</td><td>최소 기준선 (${inflationPct.toFixed(1)}%)</td></tr>
        <tr><td>실질 +1% 목표 인상액</td><td class="num">${man(targetAmount)}만원</td><td>목표 연봉 ${man(n.targetSalary)}만원 (${n.targetRatePct.toFixed(1)}%)</td></tr>
        <tr><td>제안받은 인상액</td><td class="num">${man(offeredAmount)}만원</td><td>설문에서 입력한 내년 연봉 기준 (${d.nominalRatePct.toFixed(1)}%)</td></tr>`;
    }

    const v = $("#negoVerdict");
    if (achieved) {
      v.className = "verdict";
      v.innerHTML = `제안받은 <b>${man(offeredAmount)}만원</b>(${d.nominalRatePct.toFixed(1)}%)은 물가에 실질 +1%를 더한 목표선을 이미 넘었습니다.`;
    } else {
      v.className = "verdict warn";
      // "현재 제안"은 위 스탯 카드의 제안받은 인상액(offeredAmount)을
      // 가리키므로, 그 차이도 원본 shortfallAmount를 따로 반올림하는 대신
      // 화면에 이미 보여준 targetAmount·offeredAmount의 반올림 값 기준으로
      // 다시 구한다 — 두 반올림 값이 같아 보이면 차이도 0으로 맞는다.
      v.innerHTML = `협상 테이블에서 말할 숫자는 <b>${man(targetAmount)}만원</b>(연봉 ${man(n.targetSalary)}만원, ${n.targetRatePct.toFixed(1)}%)입니다.
        물가 관리분 ${man(defendAmount)}만원에 실질 인상 1%를 더한 값이고, 현재 제안과는 ${man(displayDiff(targetAmount, offeredAmount, 0))}만원 차이입니다.`;
    }
  }

  /* ══════════════ 탭 2 · 목표 자산 ══════════════ */
  function setupGoalTab() {
    ["#goalAmount", "#goalYears", "#goalMonths", "#goalCurrent", "#goalMonthly"].forEach((sel) =>
      $(sel).addEventListener("input", renderGoal));
  }

  function clearGoalResults(guide) {
    $("#goalStats").innerHTML = "";
    $("#goalScenarioTable").innerHTML = "";
    $("#growthChart").innerHTML = `<p class="skeleton">${guide}</p>`;
    $("#goalScenarioChart").innerHTML =
      `<p class="skeleton">목표와 기간을 정하면 투자 성향별로 필요한 저축액을 비교해 드려요.</p>`;
    $("#goalVerdict").className = "verdict";
    $("#goalVerdict").textContent = guide;
    $("#goalRiskNote").textContent = "";
    $("#riskCompare").innerHTML = "";
    $("#mixFields").innerHTML = "";
    $("#mixReset").hidden = true;
    $("#donut").style.background = "none";
    $("#donutCenter").innerHTML = "";
    $("#planStats").innerHTML = "";
    $("#planLegend").innerHTML = "";
    $("#planTable").innerHTML = "";
    $("#planSrc").textContent = "";
  }

  function renderGoal() {
    const goal = Math.max(0, +$("#goalAmount").value || 0);
    const { years, months } = readGoalDuration();
    const current = Math.max(0, +$("#goalCurrent").value || 0);
    const monthly = Math.max(0, +$("#goalMonthly").value || 0);
    $("#goalMonthlyVal").textContent = `${man(monthly)}만원`;

    const err = $("#goalErr");
    if (goal > 0 && goal <= current) {
      err.textContent = "목표 금액이 현재 보유 자산보다 크지 않습니다.";
      err.hidden = false;
    } else if (goal > 0 && months <= 0) {
      err.textContent = "목표 기간은 1개월 이상이어야 합니다.";
      err.hidden = false;
    } else { err.hidden = true; }

    // 목표는 설문에서 선택 문항이라 건너뛰기 쉽다. 그때 0으로만 채워
    // "0만원이면 0만원으로 목표를 0만원 넘어섭니다" 같은 문장이 나왔다.
    // 고장으로 보이므로, 왜 비었는지와 무엇을 하면 되는지 알려 준다.
    if (goal <= 0) {
      const guide = "목표 금액을 입력하면 매달 얼마를 모아야 하는지 계산해 드려요.";
      clearGoalResults(guide);
      return;
    }
    if (months <= 0) {
      clearGoalResults("목표 기간을 1개월 이상 입력해 주세요.");
      return;
    }

    const plan = activePlan();
    if (!plan) return;
    $("#goalRiskNote").textContent =
      `${plan.desc} 기대수익률 ${pct(plan.expected_return)} (실제 시장 데이터 기준)`;
    renderPlan(monthly, plan, monthly * 12 * plan.expected_return);

    // 필요 저축액은 올림한다. 내림하면 "100만원이면 된다"고 해놓고
    // 정작 100만원으로는 목표에 못 닿는 모순이 생긴다.
    const need = Math.ceil(
      E.requiredMonthly({ goal, current, months, annualReturn: plan.expected_return })
    );
    const path = E.project({ initial: current, monthly, months, annualReturn: plan.expected_return });
    const projected = path[path.length - 1].value;
    const diff = projected - goal;

    // 목표 달성 시기 — 목표 기간 안에 이미 닿으면 그 안에서 찾고(더 일찍
    // 닿을 수도 있다), 못 닿으면 기간을 넘어서(최대 50년) 실제로 언제
    // 닿는지 다시 찾는다. 둘 다 월 적립액을 그대로 유지한다는 전제다.
    const hitMonth = diff >= 0
      ? (path.find((p) => p.value >= goal)?.month ?? months)
      : E.monthsToGoal({ initial: current, monthly, goal, annualReturn: plan.expected_return });
    const goalTimingCls = hitMonth == null ? "is-bad" : hitMonth <= months ? "is-good" : "is-warn";
    const goalTimingValue = hitMonth == null ? "50년 내 달성 어려움" : `${formatDuration(hitMonth)} 후`;
    const goalTimingSub = hitMonth == null
      ? "월 저축액을 늘려야 해요"
      : hitMonth === months
        ? "목표 기간과 같아요"
        : hitMonth < months
          ? `목표보다 ${formatDuration(months - hitMonth)} 빨라요`
          : `목표보다 ${formatDuration(hitMonth - months)} 늦어요`;

    $("#goalStats").innerHTML = `
      <div class="stat"><span class="k">필요 월 저축액</span><span class="v">${man(need)}만원</span>
        <span class="s">${plan.label} 기준</span></div>
      <div class="stat"><span class="k">현재 계획의 예상 자산</span><span class="v">${man(projected)}만원</span>
        <span class="s">${formatDuration(months)} 후</span></div>
      <div class="stat ${diff >= 0 ? "is-good" : "is-bad"}"><span class="k">${diff >= 0 ? "여유" : "부족"}</span>
        <span class="v">${man(Math.abs(diff))}만원</span>
        <span class="s">목표 ${man(goal)}만원 대비</span></div>
      <div class="stat"><span class="k">원금 대비 수익</span>
        <span class="v">${man(projected - current - monthly * months)}만원</span>
        <span class="s">복리 효과</span></div>
      <div class="stat ${goalTimingCls}"><span class="k">목표 달성 시기</span>
        <span class="v">${goalTimingValue}</span>
        <span class="s">${goalTimingSub}</span></div>`;

    const v = $("#goalVerdict");
    if (diff >= 0) {
      v.className = "verdict";
      v.innerHTML = `월 <b>${man(monthly)}만원</b>이면 ${formatDuration(months)} 뒤 <b>${man(projected)}만원</b>으로
        목표를 <b>${man(diff)}만원</b> 넘어섭니다.`;
    } else {
      v.className = "verdict warn";
      v.innerHTML = `목표까지 <b>${man(-diff)}만원</b>이 모자랍니다.
        월 저축액을 <b>${man(need)}만원</b>으로 올리거나(현재 ${man(monthly)}만원),
        기간을 늘리는 선택지가 있습니다.`;
    }

    // 성장 곡선
    const step = Math.max(1, Math.floor(months / 60));
    const pts = path.filter((_, i) => i % step === 0 || i === path.length - 1)
      .map((p) => ({ x: p.month, y: p.value, meta: `${(p.month / 12).toFixed(1)}년차` }));
    const labels = [];
    const labelYears = Math.max(years, Math.ceil(months / 12));
    for (let y = 0; y <= labelYears; y += Math.max(1, Math.round(labelYears / 5))) {
      labels.push({ at: y * 12, text: `${y}년` });
    }
    lineChart($("#growthChart"), {
      series: [{ id: "growth", label: "예상 자산", color: "var(--brand)", points: pts }],
      target: { value: goal, label: `목표 ${man(goal)}만원` },
      xLabels: labels,
      yFormat: (v) => `${man(v / 100) / 10}천만`,
      yZeroBase: true,
    });

    // 성향별 비교
    const rows = Object.keys(state.market.portfolios).map((key) => {
      const p = E.planOf(state.market, key);
      const m = Math.ceil(E.requiredMonthly({ goal, current, months, annualReturn: p.expected_return }));
      const proj = E.project({ initial: current, monthly, months, annualReturn: p.expected_return });
      return {
        key, label: p.label, color: key === state.goalRisk ? "var(--brand)" : "var(--baseline)",
        value: m, expected: p.expected_return,
        projected: proj[proj.length - 1].value,
        note: `기대수익률 ${pct(p.expected_return)}`,
      };
    });
    hBarChart($("#goalScenarioChart"), rows);
    $("#goalScenarioTable").innerHTML = rows.map((r) => `
      <tr${r.key === state.goalRisk ? ' style="font-weight:700"' : ""}>
        <td>${r.label}</td><td class="num">${pct(r.expected)}</td>
        <td class="num">${man(r.value)}만원</td><td class="num">${man(r.projected)}만원</td></tr>`).join("");
  }

  /* ══════════════ 탭 3 · 자산 타임머신 ══════════════ */
  function setupTimeTab() {
    // 예금은 '그때 샀다면' 비교 대상이 아니라 기준선이므로 목록에서 뺀다.
    const assets = state.market.assets.filter((a) => a.id !== "cash");
    const allMonths = assets.flatMap((a) => Object.keys(a.index || {}));
    const minMonth = allMonths.sort()[0];
    const maxMonth = allMonths.sort()[allMonths.length - 1];

    const input = $("#startMonth");
    input.min = minMonth;
    input.max = E.addMonths(maxMonth, -12);
    state.startMonth = E.addMonths(maxMonth, -60); // 기본 5년 전
    if (state.startMonth < minMonth) state.startMonth = minMonth;
    input.value = state.startMonth;

    input.addEventListener("input", () => {
      state.startMonth = input.value || null;
      renderTime();
    });
    $("#investAmount").addEventListener("input", renderTime);

    $("#assetPicks").innerHTML = assets.map((a) => `
      <label class="pick">
        <input type="checkbox" value="${a.id}" ${state.picks.has(a.id) ? "checked" : ""}>
        <span class="dot" style="background:${colorOf(a.id)}"></span>${a.name}
      </label>`).join("");

    $$("#assetPicks input").forEach((box) => {
      box.addEventListener("change", () => {
        if (box.checked) state.picks.add(box.value);
        else state.picks.delete(box.value);
        renderTime();
      });
    });
  }

  function clearTimeResults(message) {
    state.timeComparisonEnd = null;
    $("#timeStats").innerHTML = "";
    $("#timeChart").innerHTML = `<p class="skeleton">${message}</p>`;
    $("#timeTable").innerHTML = "";
    $("#timeVerdict").className = "verdict";
    $("#timeVerdict").textContent = message;
    $("#timeLegend").innerHTML = "";
    $("#timeSrc").textContent = "";
    $("#timingTable").innerHTML = "";
    $("#timingVerdict").textContent = message;
  }

  function renderTime() {
    const amount = Math.max(0, +$("#investAmount").value || 0);
    const start = state.startMonth;
    const picked = state.market.assets.filter((a) => state.picks.has(a.id));

    if (!start) {
      clearTimeResults("투자 시작 시점을 선택해 주세요.");
      return;
    }
    if (amount <= 0) {
      clearTimeResults("투자 금액을 입력해 주세요.");
      return;
    }
    if (!picked.length) {
      clearTimeResults("자산을 하나 이상 선택해 주세요.");
      return;
    }

    const eligible = picked.filter((asset) =>
      Object.prototype.hasOwnProperty.call(asset.index || {}, start));
    const cpiMonths = Object.keys(state.cpi.index || {}).filter((month) => month >= start).sort();
    const endCandidates = [
      cpiMonths[cpiMonths.length - 1],
      ...eligible.map((asset) => Object.keys(asset.index || {}).filter((month) => month >= start).sort().at(-1)),
    ].filter(Boolean);
    const commonEnd = endCandidates.sort()[0];

    const results = eligible.map((a) => ({ asset: a, bt: E.backtest(a, start, amount, commonEnd) }))
      .filter((r) => r.bt);
    const unavailable = picked.filter((asset) => !results.some((r) => r.asset.id === asset.id));
    if (!results.length) {
      clearTimeResults("선택한 시작 시점에 계산할 수 있는 실제 관측치가 없습니다.");
      return;
    }
    state.timeComparisonEnd = commonEnd;

    const infl = E.inflationPath(state.cpi.index, start, amount, commonEnd);
    const sorted = [...results].sort((a, b) => b.bt.finalValue - a.bt.finalValue);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const years = best.bt.years;

    // KPI
    $("#timeStats").innerHTML = `
      <div class="stat"><span class="k">투자 기간</span><span class="v">${years.toFixed(1)}년</span>
        <span class="s">${E.monthLabel(start)} 시작</span></div>
      <div class="stat is-good"><span class="k">가장 많이 오른 자산</span>
        <span class="v">${man(best.bt.finalValue)}만원</span>
        <span class="s">${best.asset.name} ${signPct(best.bt.totalReturn)}</span></div>
      <div class="stat"><span class="k">가장 적게 오른 자산</span>
        <span class="v">${man(worst.bt.finalValue)}만원</span>
        <span class="s">${worst.asset.name} ${signPct(worst.bt.totalReturn)}</span></div>
      <div class="stat"><span class="k">물가만큼만 올랐다면</span>
        <span class="v">${infl ? man(infl.path[infl.path.length - 1].value) : "—"}만원</span>
        <span class="s">같은 기간 소비자물가</span></div>`;

    // 결론 문장
    const inflFinal = infl ? infl.path[infl.path.length - 1].value : null;
    const beat = inflFinal ? results.filter((r) => r.bt.finalValue > inflFinal) : [];
    const v = $("#timeVerdict");
    v.className = "verdict";
    v.innerHTML = `${E.monthLabel(start)}에 <b>${man(amount)}만원</b>을 넣었다면,
      ${best.asset.name}은 ${E.monthLabel(commonEnd)} 기준 <b>${man(best.bt.finalValue)}만원</b>입니다
      (연평균 ${signPct(best.bt.cagr)}, 최대 낙폭 ${signPct(best.bt.mdd)}).
      계산 가능한 ${results.length}개 중 <b>${beat.length}개</b>가 같은 기간 물가상승을 이겼습니다.
      다만 이것은 선택한 한 시작 달의 기록이지, 앞으로의 수익을 약속하는 숫자는 아닙니다.${unavailable.length
        ? ` 선택한 시작 달의 실제 값이 없어 제외된 자산: ${unavailable.map((a) => a.name).join(", ")}.`
        : ""}`;

    // 차트
    const series = results.map((r) => ({
      id: r.asset.id, label: r.asset.name, color: colorOf(r.asset.id),
      points: r.bt.path.map((p) => ({ x: E.monthToNum(p.month), y: p.value, meta: E.monthLabel(p.month) })),
    }));
    if (infl) {
      series.push({
        id: "cpi", label: "소비자물가", color: "var(--text-muted)", dashed: true,
        points: infl.path.map((p) => ({ x: E.monthToNum(p.month), y: p.value, meta: E.monthLabel(p.month) })),
      });
    }

    const xs = series.flatMap((s) => s.points.map((p) => p.x));
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const labels = [];
    const stepM = Math.max(12, Math.round((x1 - x0) / 5 / 12) * 12);
    for (let x = x0; x <= x1; x += stepM) {
      labels.push({ at: x, text: `${Math.floor(x / 12)}` });
    }

    lineChart($("#timeChart"), {
      series, xLabels: labels,
      yFormat: (val) => `${man(val)}만`,
      yZeroBase: true,
    });

    $("#timeLegend").innerHTML = series.map((s) =>
      `<span class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${s.label}</span>`
    ).join("");

    $("#timeSrc").textContent =
      `Yahoo Finance 월별 가격 · 물가는 OECD 한국 CPI · 공통 종료 ${commonEnd} · 스냅샷 ${state.market.source_fetched_at.slice(0, 10)}`;

    // 표
    $("#timeTable").innerHTML = sorted.map((r) => `
      <tr>
        <td><span class="legend-swatch" style="background:${colorOf(r.asset.id)};display:inline-block;margin-right:.4rem"></span>${r.asset.name}
          ${r.asset.krw_converted ? '<span class="risk-badge risk-mid">원화환산</span>' : ""}</td>
        <td class="num">${signPct(r.bt.totalReturn)}</td>
        <td class="num">${signPct(r.bt.cagr)}</td>
        <td class="num">${Number.isFinite(r.bt.volatility) ? pct(r.bt.volatility) : "—"}</td>
        <td class="num">${signPct(r.bt.mdd)}</td></tr>`).join("");

    renderTiming(results, amount, start, commonEnd);
  }

  function renderTiming(results, amount, start, endMonth) {
    const windows = results.map((r) => ({
      asset: r.asset,
      result: E.backtestWindow(r.asset, start, amount, 6, endMonth),
    })).filter((item) => item.result);

    if (!windows.length) {
      $("#timingTable").innerHTML = "";
      $("#timingVerdict").textContent = "앞뒤 기간을 비교할 관측치가 충분하지 않습니다.";
      return;
    }

    $("#timingTable").innerHTML = windows.map(({ asset, result }) => {
      const delta = result.selected == null ? null : result.selected / result.median - 1;
      const tag = delta == null ? "—" :
        (Math.abs(delta) < 0.03 ? "중앙값과 비슷" : (delta > 0 ? `중앙값보다 +${(delta * 100).toFixed(1)}%` : `중앙값보다 ${(delta * 100).toFixed(1)}%`));
      return `<tr>
        <td>${asset.name}<span class="table-sub">실제 시작 달 ${result.count}개</span></td>
        <td class="num">${man(result.min)}~${man(result.max)}만원</td>
        <td class="num">${man(result.median)}만원</td>
        <td class="num">${man(result.selected)}만원<span class="table-sub">${tag}</span></td>
      </tr>`;
    }).join("");

    const sensitive = [...windows].sort((a, b) =>
      ((b.result.max - b.result.min) / b.result.median) -
      ((a.result.max - a.result.min) / a.result.median))[0];
    const spread = (sensitive.result.max - sensitive.result.min) / sensitive.result.median;
    $("#timingVerdict").innerHTML = `<b>${sensitive.asset.name}</b>은 시작 달을 앞뒤 6개월만 옮겨도
      지금 가치가 <b>${man(sensitive.result.min)}만~${man(sensitive.result.max)}만원</b>으로 달라집니다
      (중앙값 대비 범위 ${(spread * 100).toFixed(0)}%). 따라서 가장 좋은 한 날짜보다 <b>범위와 중앙값</b>을 함께 보는 편이 안전합니다.`;
  }

  /* ══════════════ 계산 근거 ══════════════ */
  function renderBasis() {
    const personaSource = {
      name: "국가데이터처 가계동향조사",
      use: "생활 유형별 월평균 소비지출 시작값",
      url: PERSONA_DATA.source.url,
      reference: true,
    };
    const sources = [...state.meta.sources, personaSource];
    $("#srcList").innerHTML = sources.map((s) => {
      const badge = s.reference
        ? '<span class="risk-badge risk-low">공식 통계 기준값</span>'
        : (s.live_in_browser
          ? '<span class="risk-badge risk-low">접속 시 최신값 조회</span>'
          : `<span class="risk-badge risk-mid">주 1회 스냅샷</span> <span style="color:var(--text-muted)">${s.reason || ""}</span>`);
      return `<li><strong><a href="${s.url}">${s.name} ↗</a></strong>
        — ${s.use} ${badge}</li>`;
    }).join("");

    // meta.json에는 재현·감사를 위해 판정 수치가 든 원문을 그대로 두되,
    // 화면에서는 사용자가 바로 이해할 수 있는 문장으로 번역한다.
    const clean = (state.meta.notes || []).map((note) =>
      typeof note === "string" && note.includes("원/달러 2017-09: 0.1154")
        ? "원/달러 2017년 9월의 비정상 값 1건을 앞뒤 달과 비교해 오류로 판단하고 제외했습니다."
        : note
    );
    $("#cleanList").innerHTML = clean.length
      ? clean.map((n) => `<li>${n}</li>`).join("")
      : `<li>이번 수집분에서 제외된 값은 없습니다.</li>`;

    $("#assumeList").innerHTML = state.meta.assumptions.map((a) => `<li>${a}</li>`).join("");

    const gen = new Date(state.meta.generated_at);
    $("#buildInfo").classList.remove("skeleton-bar");
    $("#buildInfo").textContent =
      `데이터 갱신 ${gen.toLocaleString("ko-KR")} · 전체 물가·환율·비트코인은 접속 시 최신값 조회, 품목별 물가·시세 시계열은 주 1회 스냅샷입니다.`;
  }

  /* ══════════════ 전체 렌더 ══════════════ */
  // 인쇄(PDF) 문서 맨 위에만 보이는 제목·생성일·요약 한 줄 — 화면에는
  // .print-only가 항상 숨긴다. 새 계산 없이 이미 화면에 있는 값만
  // 다시 읽어서 문장으로 합친다.
  function renderPrintMeta() {
    const today = new Date();
    const dateStr = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일 생성`;

    const reportMeta = $("#printMetaReport");
    if (reportMeta) {
      const persona = $("#personaLabel")?.textContent || "—";
      const cur = Math.max(0, +$("#curSalary").value || 0);
      const next = Math.max(0, +$("#nextSalary").value || 0);
      reportMeta.textContent = cur > 0
        ? `가구 유형: ${persona} · 현재 연봉 ${man(cur)}만원 · 내년 예상 연봉 ${man(next)}만원 · ${dateStr}`
        : dateStr;
    }

    const goalMeta = $("#printMetaGoal");
    if (goalMeta) {
      const goal = Math.max(0, +$("#goalAmount").value || 0);
      const { months } = readGoalDuration();
      goalMeta.textContent = goal > 0
        ? `목표 금액 ${man(goal)}만원 · 목표 기간 ${formatDuration(months)} · ${dateStr}`
        : dateStr;
    }

    const timeMeta = $("#printMetaTime");
    if (timeMeta) {
      const amount = Math.max(0, +$("#investAmount").value || 0);
      const assetNames = state.market
        ? state.market.assets
            .filter((a) => state.picks.has(a.id)
              && state.startMonth
              && Object.prototype.hasOwnProperty.call(a.index || {}, state.startMonth))
            .map((a) => a.name).join(", ")
        : "";
      timeMeta.textContent = state.startMonth
        ? `투자 시작 ${E.monthLabel(state.startMonth)}${state.timeComparisonEnd ? ` · 비교 종료 ${E.monthLabel(state.timeComparisonEnd)}` : ""} · 투자 금액 ${man(amount)}만원${assetNames ? ` · 비교 자산 ${assetNames}` : ""} · ${dateStr}`
        : dateStr;
    }
  }

  function renderAll() {
    if (!state.market) return;
    renderMine();
    renderInflationForecast();
    renderGap();
    renderGoal();
    renderTime();
    renderScenarios();
    renderPrintMeta();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
