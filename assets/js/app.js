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

  const ASSET_COLOR = {
    cash: "var(--series-1)", bond10y: "var(--series-3)", kodex200: "var(--series-2)",
    sp500: "var(--series-4)", gold: "var(--series-5)", bitcoin: "var(--series-6)",
  };
  const colorOf = (id) => ASSET_COLOR[id] || "var(--text-muted)";

  // 체감 물가 격차를 실물 감각으로 보여주는 기준가 — 매장마다 다른
  // 가정값이라 '가정값' 배지로 명시한다(CLAUDE.md의 "가정값 0개" 원칙에 대한
  // 예외로 기록해 둠).
  const ICED_AMERICANO_PRICE = 4500;

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
  function scaleSpending(spending, nextTotal, keys = Object.keys(spending)) {
    const subset = Object.fromEntries(keys.map((k) => [k, spending[k] || 0]));
    const current = spendingTotal(subset);
    const zeroed = Object.fromEntries(keys.map((key) => [key, 0]));
    if (current <= 0 || nextTotal <= 0) {
      return { ...spending, ...zeroed };
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
    spending: roundSpending(PERSONAS[DEFAULT_PERSONA].spending),
    persona: DEFAULT_PERSONA,
    personalRate: null,
    aiContext: null,
    aiCache: new Map(),
  };

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
    setupHomeFlow();
    setupReportEditing();
    $("#mixReset").addEventListener("click", () => {
      state.customWeights = null;
      renderAll();
    });
    setupFinalConclusion();
    setupNextSteps();
    setupScrollReveal();
    renderBasis();
    renderAll();

    // 실시간은 화면이 다 그려진 뒤에 붙인다 (실패해도 화면은 이미 완성)
    // 실시간 값이 들어오면서 위쪽 섹션 높이가 바뀔 수 있어(티커·물가
    // 출처 문구 등), 해시로 스크롤한 위치가 살짝 밀릴 수 있다. 다
    // 반영된 뒤 한 번 더 맞춰준다.
    hydrateLive().then(scrollToHashSection);
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
         실시간 · OECD 기준 ${d.month} 한국 소비자물가 <b>${d.value.toFixed(1)}%</b>를 기본값으로 넣었습니다.`;
      renderAll();
    } else {
      $("#inflSource").innerHTML =
        `<span class="live-dot stale" style="display:inline-block;vertical-align:middle"></span>
         저장된 스냅샷 · ${state.cpi.latest.month} 기준 ${state.cpi.latest.yoy.toFixed(1)}%
         (실시간 조회 실패)`;
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

  // 리포트가 막 보이기 시작하는 시점(설문을 마쳤거나 재방문자라 바로
  // 공개될 때)에 한 번 호출한다. 공유 링크 등으로 해시를 이미 들고
  // 들어온 경우, 그 순간까지는 섹션이 hidden이라 스크롤해도 자리가
  // 안 잡히므로 리포트가 드러난 직후에 시도해야 한다.
  function scrollToHashSection() {
    const id = location.hash.slice(1);
    if (!id) return;
    const target = document.getElementById(id);
    if (!target || target.hidden) return;
    requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  /* ══════════════ 홈 · 온보딩 → 로딩 → 요약 ══════════════
     Q1~Q5을 순서대로 물어보고, 답을 각 섹션의 실제 입력(persona 버튼·
     월 생활비·연봉 필드·투자성향 세그먼트·목표 필드)에 그대로 반영한다.
     설문 중에는 리포트 4개 섹션과 탭을 전부 숨겨 둔다 — 아직 안 끝난
     설문 아래로 결과가 미리 보이면 안 된다. 설문을 마치면(또는
     재방문자면) 한꺼번에 드러낸다. 한 번 마치면 localStorage에 저장해
     재방문 시 다시 묻지 않는다. */
  // 서비스명은 "연봉 성적표"로 바뀌었지만 키는 그대로 둔다 — 이미 저장된
  // 기존 사용자의 값과의 연결이 끊기기만 할 뿐 바꿔서 얻는 게 없다.
  const ONBOARD_KEY = "salarygap-profile";
  const TOTAL_STEPS = 3;
  // panel-goal/panel-time은 일부러 뺐다 — 기본 리포트 스크롤에 자동으로
  // 드러나지 않고, #nextSteps의 버튼을 눌러야 펼쳐진다(revealPanel 참고).
  // nextSteps 자체는 여기 포함시켜서, 설문 도중에는 그 버튼 2개조차
  // DOM에 안 보이게 한다(전에는 hidden이 아예 없어서 설문 중에도
  // 스크롤하면 보이는 버그가 있었다).
  const REPORT_PANEL_IDS = ["panel-mine", "panel-gap", "panel-final", "nextSteps"];

  function setReportVisible(visible) {
    REPORT_PANEL_IDS.forEach((id) => { $(`#${id}`).hidden = !visible; });
    $("#ticker").hidden = !visible;
    $("#basis").hidden = !visible;
    // 목표/타임머신은 항상 처음엔(그리고 재입력 시엔 다시) 접힌 상태로
    // 되돌린다 — REPORT_PANEL_IDS에 없어서 위 루프가 안 건드리기 때문에
    // 여기서 명시적으로 처리해야 재입력 후에도 이전에 펼쳤던 상태가
    // 남아있지 않는다.
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

    if (profile.monthlySpend != null) setInputAndFire("#monthlySpend", profile.monthlySpend);
    setInputAndFire("#curSalary", profile.curSalary);
    setInputAndFire("#nextSalary", profile.nextSalary);
    setInputAndFire("#goalAmount", profile.goalAmount);
    setInputAndFire("#goalYears", profile.goalYears);
    setInputAndFire("#goalMonths", profile.goalMonths);
    setInputAndFire("#goalCurrent", profile.goalCurrent);
    renderAll();
  }

  // "연봉 성적표"에 쓸 100점 만점 점수 — "실질임금 진단"·"내 물가" 두
  // 탭에서 이미 계산 중인 값만 모아서 E.salaryScore에 건네준다.
  // 목표 자산·투자 성향은 사용자가 주관적으로 정하는 값이라 일부러
  // 뺐다 — "연봉과 물가만 객관적으로 비교한다"는 취지를 지키기 위해서다.
  function computeScoreInputs() {
    const official = state.cpi.latest.yoy;
    const rate = state.personalRate;
    const diffPp = rate == null ? null : rate - official;

    const cur = Math.max(0, +$("#curSalary").value || 0);
    const next = Math.max(0, +$("#nextSalary").value || 0);
    const realRatePct = cur > 0
      ? E.diagnose({ curSalary: cur, nextSalary: next, inflationPct: state.inflation }).realRatePct
      : null;

    return { realRatePct, diffPp };
  }

  // 등급 구간 — 링 안에 짧게 붙이고, 기준 자체는 "어떻게 계산했나요?"
  // 펼침 영역에 공개한다(숨겨진 기준으로 평가받는 느낌을 주지 않기 위해).
  // 알파벳 등급(S/A/B/C/D/F)은 상/중상/중/중하/하 5단계로 바꿨다.
  const SCORE_GRADES = [
    { min: 80, grade: "상", cls: "is-good" },
    { min: 60, grade: "중상", cls: "is-good" },
    { min: 40, grade: "중", cls: "is-warn" },
    { min: 20, grade: "중하", cls: "is-bad" },
    { min: 0,  grade: "하", cls: "is-bad" },
  ];
  function scoreBand(total) {
    return SCORE_GRADES.find((g) => total >= g.min);
  }

  // 점수·도넛·등급을 하나로, 세부 수치는 기본 접힌 "어떻게 계산했나요?"
  // 안에만 둔다 — 같은 숫자가 화면에 3번(큰 텍스트/링/카드) 반복되던
  // 걸 링 하나로 줄이고, 나머지는 궁금한 사람만 펼쳐보게 한다.
  function renderScore() {
    const data = E.salaryScore(computeScoreInputs());
    const heroEl = $("#scoreHero");
    const headline = $("#homeSummaryHeadline");

    if (!data) {
      heroEl.hidden = true;
      headline.hidden = false;
      headline.textContent = "정보를 더 입력하면 점수를 계산해드려요";
      return;
    }

    headline.hidden = true;
    const { total, items } = data;
    const band = scoreBand(total);
    const color = band.cls === "is-good" ? "var(--good)" : band.cls === "is-bad" ? "var(--critical)" : "var(--warning)";

    heroEl.hidden = false;
    $("#scoreNum").textContent = total;
    $("#scoreRing").style.background = `conic-gradient(${color} ${total}%, var(--surface-sunk) 0)`;
    $("#scoreGradeLine").textContent = band.grade;
    $("#scoreGradeLine").className = `score-grade-line ${band.cls}`;

    $("#scoreDetailItems").innerHTML = items.map((it) =>
      `<li><b>${it.label} ${it.score}점</b> · ${it.note}</li>`).join("");

    // 점수 도입 전 쓰던 풀이 문단 — 접이식 안으로 옮겼으니 굳이 타이핑
    // 연출 없이 바로 채운다(펼치기 전까지는 어차피 안 보인다).
    $("#homeSummarySub").textContent = buildNarrative();
  }

  // 목표 기간을 "년"과 "개월" 두 필드로 나눠 받다 보니, 이 값을 쓰는
  // renderGoal·buildNarrative·buildFinalConclusion 세 곳이 각자 따로
  // 읽고 클램프하면 어긋나기 쉽다. 한 곳에서만 읽고 총 개월 수로
  // 변환해 나머지는 이 결과만 쓰게 한다.
  function readGoalDuration() {
    const years = Math.max(0, Math.min(40, +$("#goalYears").value || 0));
    const extraMonths = Math.max(0, Math.min(11, +$("#goalMonths").value || 0));
    return { years, extraMonths, months: Math.max(1, years * 12 + extraMonths) };
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
  function buildNarrative() {
    const official = state.cpi.latest.yoy;
    const rate = state.personalRate;
    if (rate == null) {
      return "아직 지출 정보가 없어서 풀이를 시작할 수 없어요.\n리포트에서 월 생활비를 입력하면 여기서부터 다시 풀어드릴게요.";
    }

    const diff = rate - official;
    const lines = [
      Math.abs(diff) < 0.05
        ? `당신의 체감 물가는 ${rate.toFixed(1)}%로, 공식 통계와 거의 같아요.`
        : diff > 0
          ? `당신의 체감 물가는 ${rate.toFixed(1)}%로, 공식 통계보다 ${diff.toFixed(1)}%p 높아요.`
          : `당신의 체감 물가는 ${rate.toFixed(1)}%로, 공식 통계보다 ${Math.abs(diff).toFixed(1)}%p 낮아요.`,
    ];

    const cur = Math.max(0, +$("#curSalary").value || 0);
    const next = Math.max(0, +$("#nextSalary").value || 0);
    if (cur > 0) {
      const d = E.diagnose({ curSalary: cur, nextSalary: next, inflationPct: state.inflation });
      lines.push(d.beatsInflation
        ? "다행히 내년 연봉은 물가를 이기고 있어서, 실질 소득이 조금씩 늘어나는 흐름이에요."
        : `하지만 내년 연봉은 물가를 다 따라가지 못해서, 실질적으로는 연 ${man(d.gap)}만원만큼 뒷걸음질 치고 있어요.`);
    }

    lines.push("아래에서 하나씩 풀어드릴게요.");
    return lines.join("\n");
  }

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

  // 리포트 맨 끝의 결론 — 4개 섹션 결과를 한데 모아 정리한다.
  // 투자 권유로 읽히면 안 되므로 단정 대신 "~해볼 만해요" 같은 선택지
  // 톤을 쓰고, 마지막 줄에서 참고자료라는 점을 다시 한 번 짚는다.
  function buildFinalConclusion() {
    const rate = state.personalRate;
    if (rate == null) {
      return "아직 결과를 계산할 수 없어요.\n리포트에서 값을 입력하면 여기서 정리해 드릴게요.";
    }

    const lines = [];

    lines.push(`체감 물가 ${rate.toFixed(1)}%를 방어하려면 연봉을 그만큼 올려받거나, 그만큼 수익을 내야 해요.`);

    const cur = Math.max(0, +$("#curSalary").value || 0);
    const next = Math.max(0, +$("#nextSalary").value || 0);
    if (cur > 0) {
      const d = E.diagnose({ curSalary: cur, nextSalary: next, inflationPct: state.inflation });
      lines.push(d.beatsInflation
        ? "내년 연봉은 물가를 이기고 있어서, 지금 페이스라면 실질 소득은 지켜지고 있어요."
        : "내년 연봉은 물가를 다 따라가지 못하고 있어서, 그 차이를 투자나 협상으로 메워야 해요.");
    }

    lines.push("과거 데이터는 참고 자료일 뿐, 결정은 늘 본인의 몫입니다.");
    return lines.join("\n");
  }

  // 스크롤로 맨 아래 결론 카드에 처음 닿는 순간에만 타이핑한다 —
  // 스크롤을 왔다갔다 할 때마다 다시 타이핑되면 산만하다.
  function setupFinalConclusion() {
    const target = $("#panel-final");
    const body = $("#finalBody");
    let typed = false;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting || typed || target.hidden) return;
        typed = true;
        typewriter(body, buildFinalConclusion());
        observer.disconnect();
      });
    }, { threshold: 0.35 });
    observer.observe(target);
  }

  // 목표 자산/타임머신은 기본 스크롤에 없다 — 버튼을 눌러야 펼쳐진다.
  // renderAll()이 이미 renderGoal()/renderTime()을 항상 호출해 두므로
  // 내용은 hidden 상태에서도 다 그려져 있다 — hidden만 풀면 된다.
  function setupNextSteps() {
    function revealPanel(id) {
      const el = $(`#${id}`);
      el.hidden = false;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    $("#revealGoalBtn").addEventListener("click", () => revealPanel("panel-goal"));
    $("#revealTimeBtn").addEventListener("click", () => revealPanel("panel-time"));
  }

  // 리포트를 스크롤해서 내려갈 때 섹션이 하나씩 나타나게 한다 — 설문
  // 중엔 패널 자체가 hidden이라 관찰해도 안 걸리다가, 리포트가 공개된
  // 뒤 스크롤하면서 순서대로 걸린다. 한 번 나타난 블록은 다시 안 건드림
  // (스크롤을 왔다갔다 할 때마다 깜빡이면 산만하다 — setupFinalConclusion과
  // 같은 이유).
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

  function setupHomeFlow() {
    const loadingView = $("#homeLoading");
    const summaryView = $("#homeSummary");
    const wizardView = $("#homeOnboarding");
    const steps = $$(".onboarding-step");
    const progressWrap = $("#onboardProgressWrap");
    const progressFill = $("#onbProgressFill");
    const progressText = $("#onbProgressText");
    let stepIndex = 0;
    let draft = freshDraft();

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
      stepIndex = i;
      steps.forEach((s) => { s.hidden = Number(s.dataset.step) !== i; });
      progressWrap.hidden = i === 0;
      if (i > 0) {
        progressFill.style.width = `${(i / TOTAL_STEPS) * 100}%`;
        progressText.textContent = `${i} / ${TOTAL_STEPS}`;
      }
      // 방금 고른 생활 유형의 평균값을 미리 채워 둔다 — 사용자는 그대로 두거나 고칠 수 있다.
      if (i === 2) {
        $("#onbMonthlySpend").value = Math.round(draft.monthlySpend);
        renderOnbSpendFields();
        renderOnbSpendDonut();
      }
      scrollHomeToTop();
    }

    function renderSummary() {
      renderScore();
      summaryView.hidden = false;
      // 첫 화면에는 타이틀·설명·시작하기만 보여야 한다. 리포트 4개 섹션과
      // 탭은 설문이 끝나고 포트폴리오가 준비된 뒤에야 의미가 생기므로
      // 그때 한꺼번에 드러낸다.
      setReportVisible(true);
      scrollHomeToTop();
      // 공유 링크 등으로 특정 섹션 해시를 들고 들어온 경우, 방금
      // scrollHomeToTop이 맨 위로 올려놓은 걸 다시 그 섹션으로 옮긴다
      // (이 호출이 나중이라 최종 스크롤 위치를 이긴다).
      scrollToHashSection();
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

    // ---- 2 · 월 생활비 (세부 항목 토글 + 도넛 미리보기) ----
    // 리포트 "내 물가" 탭이 쓰는 SPEND_GROUPS/scaleSpending을 그대로
    // draft.spending에 적용한다 — 계산 로직을 새로 만들지 않는다.
    const draftGroupTotal = (g) => g.members.reduce((sum, id) => sum + (draft.spending[id] || 0), 0);

    function renderOnbSpendFields() {
      $("#onbSpendFields").innerHTML = SPEND_GROUPS.map((g) => `
        <div class="spend-row">
          <label for="onb-sp-${g.id}">
            <b>${g.name}</b>
            <small>${g.hint}</small>
          </label>
          <span class="input-wrap">
            <input type="number" id="onb-sp-${g.id}" min="0" step="1" inputmode="numeric" value="${Math.round(draftGroupTotal(g))}">
            <span>만원</span>
          </span>
        </div>`).join("");

      SPEND_GROUPS.forEach((g) => {
        $(`#onb-sp-${g.id}`).addEventListener("input", (e) => {
          const nextGroupTotal = Math.max(0, +e.target.value || 0);
          draft.spending = scaleSpending(draft.spending, nextGroupTotal, g.members);
          draft.monthlySpend = spendingTotal(draft.spending);
          $("#onbMonthlySpend").value = Math.round(draft.monthlySpend);
          renderOnbSpendDonut();
        });
      });
    }

    function renderOnbSpendDonut() {
      const total = spendingTotal(draft.spending);
      let acc = 0;
      const stops = SPEND_GROUPS.map((g) => {
        const weight = total > 0 ? draftGroupTotal(g) / total : 0;
        const from = acc * 100, to = (acc + weight) * 100;
        acc += weight;
        return `${SPEND_GROUP_COLOR[g.id]} ${from.toFixed(2)}% ${to.toFixed(2)}%`;
      });
      $("#onbSpendDonut").style.background =
        total > 0 ? `conic-gradient(${stops.join(",")})` : "var(--surface-sunk)";
      $("#onbSpendDonutCenter").innerHTML =
        `<div style="font-size:.68rem;color:var(--text-muted)">총 생활비</div>
         <div style="font-size:1.2rem;font-weight:800">${man(total)}만원</div>`;
      $("#onbSpendLegend").innerHTML = SPEND_GROUPS.map((g) => {
        const weight = total > 0 ? (draftGroupTotal(g) / total) * 100 : 0;
        return `<span class="legend-item"><span class="legend-swatch" style="background:${SPEND_GROUP_COLOR[g.id]}"></span>
          ${g.name} ${weight.toFixed(0)}%</span>`;
      }).join("");
    }

    $("#onbMonthlySpend").addEventListener("input", (e) => {
      const nextTotal = Math.max(0, +e.target.value || 0);
      draft.spending = scaleSpending(draft.spending, nextTotal);
      renderOnbSpendFields();
      renderOnbSpendDonut();
    });

    $("#onbNext2").addEventListener("click", () => {
      draft.monthlySpend = Math.max(0, +$("#onbMonthlySpend").value || 0);
      showStep(3);
    });

    // ---- 3 · 연봉 (마지막 문항) ----
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
    $("#homeReportBtn").addEventListener("click", () =>
      $("#panel-mine").scrollIntoView({ behavior: "smooth", block: "start" }));
    $("#homeRestartBtn").addEventListener("click", () => {
      // 바로 위 "리포트 보기" 버튼과 가까이 있어 오클릭하기 쉬운데,
      // 이 버튼은 지금까지 입력한 값을 전부 날리는 되돌릴 수 없는 동작이라
      // 한 번 더 확인한다.
      if (!confirm("처음부터 다시 입력할까요? 지금까지 입력한 내용은 모두 사라져요.")) return;
      localStorage.removeItem(ONBOARD_KEY);
      summaryView.hidden = true;
      setReportVisible(false);
      draft = freshDraft();
      $$("#onbPersonaGrid button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.persona === DEFAULT_PERSONA)));
      wizardView.hidden = false;
      showStep(0);
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
      { test: (id) => id === "monthlySpend" || id === "onbMonthlySpend", min: 0, max: 5000, label: "월 생활비", money: true, amount: true },
      { test: (id) => id.startsWith("sp-"), min: 0, max: 3000, label: "지출 항목", money: true, amount: true },
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

  function syncSpendingFields(syncTotal = true) {
    SPEND_GROUPS.forEach((g) => {
      const input = $(`#sp-${g.id}`);
      if (input) input.value = Math.round(groupTotal(g));
    });
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
      $("#panel-mine").innerHTML =
        `<div class="load-error">품목별 물가 데이터가 없습니다. 파이프라인을 다시 실행해 주세요.</div>`;
      return;
    }

    const row = (g) => {
      return `<div class="spend-row">
        <label for="sp-${g.id}">
          <b>${g.name}</b>
          <small>${g.hint}</small>
        </label>
        <span class="input-wrap">
          <input type="number" id="sp-${g.id}" min="0" step="1" inputmode="numeric" value="${Math.round(groupTotal(g))}" readonly>
          <span>만원</span>
        </span>
      </div>`;
    };

    $("#spendFields").innerHTML = SPEND_GROUPS.map(row).join("");

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

    $("#aiExplainBtn").addEventListener("click", openAIInsight);
    $("#aiRetryBtn").addEventListener("click", openAIInsight);
    $("#aiCloseBtn").addEventListener("click", () => $("#aiInsightDialog").close());
    $("#aiInsightDialog").addEventListener("click", (event) => {
      if (event.target === $("#aiInsightDialog")) $("#aiInsightDialog").close();
    });
  }

  /* "비중 × 상승률을 다 더한다"는 말은 식으로만 보면 안 와닿는다.
     그래서 내가 지금 넣은 숫자로 실제 계산을 한 줄씩 따라가게 보여준다.
     기여도가 가장 큰 항목 하나를 예로 들고, 마지막에 합이 내 물가라는
     것까지 이어 준다. 툴팁은 마우스를 올려야 보여서 발견되지 않는다. */
  /* 툴팁은 마우스가 있어야 보인다. 발표 때 휴대폰으로 여는 사람이
     대부분이라, 같은 내용을 접이식 목록으로도 항상 열어 볼 수 있게 둔다. */
  function renderCatLegend() {
    const box = $("#catLegend");
    if (!box || box.childElementCount) return;
    box.innerHTML = SPEND_GROUPS.map((g) =>
      `<dt>${g.name}</dt><dd>${g.examples}</dd>`).join("");
  }

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

  function renderMine() {
    const cats = state.cpi.categories || [];
    if (!cats.length) return;

    const spending = state.spending;

    const result = E.personalInflation(spending, cats);
    const official = state.cpi.latest.yoy;

    if (!result) {
      state.personalRate = null;
      state.aiContext = null;
      $("#aiExplainBtn").disabled = true;
      $("#officialRate").textContent = `${official.toFixed(1)}%`;
      $("#officialRate").classList.remove("skeleton-bar");
      $("#officialMonth").textContent = `${state.cpi.latest.month} 기준`;
      $("#personalRate").textContent = "—";
      $("#personalRate").classList.remove("skeleton-bar");
      $("#vsGap").className = "vs-mid";
      $("#vsGap").textContent = "입력 필요";
      $("#mineVerdict").className = "verdict";
      $("#mineVerdict").textContent = "지출을 하나 이상 입력해 주세요.";
      $("#americanoCallout").innerHTML = "";
      $("#spendTotal").textContent = "0만원";
      $("#contribSummary").hidden = true;
      $("#contribRank").innerHTML = "";
      $("#contribRankMore").hidden = true;
      $("#contribChart").innerHTML = `<p class="skeleton">월 생활비를 입력하면 항목별 기여도를 보여드립니다.</p>`;
      $("#cumChart").innerHTML = `<p class="skeleton">월 생활비를 입력하면 10년 누적 물가를 계산합니다.</p>`;
      $("#cumLegend").innerHTML = "";
      $("#cumStats").innerHTML = "";
      $("#mineActionStats").innerHTML = "";
      $("#mineAction").className = "verdict";
      $("#mineAction").textContent = "월 생활비를 입력하면 필요한 소득·수익률 기준을 계산합니다.";
      return;
    }

    state.personalRate = result.rate;
    $("#spendTotal").textContent = `${man(result.total)}만원`;
    const diff = result.rate - official;

    $("#officialRate").textContent = `${official.toFixed(1)}%`;
    $("#officialRate").classList.remove("skeleton-bar");
    $("#officialMonth").textContent = `${state.cpi.latest.month} 기준`;
    $("#personalRate").textContent = `${result.rate.toFixed(1)}%`;
    $("#personalRate").classList.remove("skeleton-bar");

    const mid = $("#vsGap");
    const side = $("#vsRow").querySelector(".vs-side.accent");
    if (Math.abs(diff) < 0.05) {
      mid.className = "vs-mid"; mid.textContent = "거의 같음";
      side.classList.remove("under");
    } else if (diff > 0) {
      mid.className = "vs-mid over"; mid.textContent = `+${diff.toFixed(1)}포인트 높음`;
      side.classList.remove("under");
    } else {
      mid.className = "vs-mid under"; mid.textContent = `${diff.toFixed(1)}포인트 낮음`;
      side.classList.add("under");
    }

    // 결론 문장 — 조작하면 같이 바뀐다
    const sorted = [...result.contributions].sort((a, b) => b.contribution - a.contribution);
    const top = sorted[0];
    state.aiContext = {
      officialRate: official,
      personalRate: result.rate,
      gapPp: diff,
      topCategoryId: top.id,
      topCategory: top.name,
      topSharePct: top.weight * 100,
      topRatePct: top.rate,
    };
    $("#aiExplainBtn").disabled = false;
    const v = $("#mineVerdict");
    if (diff > 0.05) {
      v.className = "verdict warn";
      v.innerHTML = `당신의 물가는 공식 통계보다 <b>${diff.toFixed(1)}포인트 높습니다.</b>
        가장 크게 밀어올린 건 <b>${top.name}</b>(지출의 ${(top.weight * 100).toFixed(0)}%,
        이 품목만 ${top.rate >= 0 ? "+" : ""}${top.rate.toFixed(1)}%)입니다.`;
    } else if (diff < -0.05) {
      v.className = "verdict";
      v.innerHTML = `당신의 물가는 공식 통계보다 <b>${Math.abs(diff).toFixed(1)}포인트 낮습니다.</b>
        물가가 덜 오른 품목에 지출이 몰려 있습니다.`;
    } else {
      v.className = "verdict";
      v.innerHTML = `당신의 지출 구성은 전국 평균과 비슷해서, 체감 물가도 공식 통계와 거의 같습니다.`;
    }

    // 만원 단위 %p 격차보다 실물로 와닿는 지표 — 이번 달 체감 격차를
    // 아이스 아메리카노 잔수로 환산한다.
    const monthlyGapWon = result.total * (diff / 100); // 만원
    const cups = Math.round((Math.abs(monthlyGapWon) * 10000) / ICED_AMERICANO_PRICE);
    $("#americanoCallout").innerHTML = `
      <span class="americano-icon" aria-hidden="true">☕</span>
      <p>아이스 아메리카노 기준으로 보면, 한 달에 <b>${cups}잔</b> 값이 ${diff >= 0 ? "더 들어요" : "덜 들어요"}
        <span class="risk-badge risk-mid">가정값</span></p>
      <p class="americano-sub">기준가 ${ICED_AMERICANO_PRICE.toLocaleString("ko-KR")}원 · 이번 달 격차 기준</p>`;

    const sp = state.cpi.spread;
    if (sp) {
      $("#spreadNote").innerHTML =
        `같은 달인데도 <b>${sp.high.name} +${sp.high.yoy.toFixed(1)}%</b>,
         <b>${sp.low.name} +${sp.low.yoy.toFixed(1)}%</b>로 ${sp.gap.toFixed(1)}%p 벌어져 있습니다.
         "물가 ${official.toFixed(1)}%"는 아무의 물가도 아닙니다.`;
    }

    // 기여도 분해 — 계산(top)은 12개 실카테고리 그대로 쓰고, 그래프만
    // 5개 그룹으로 묶어서 보여준다(품목이 너무 많아 읽기 힘들다는
    // 피드백). 품목이 전체 평균보다 빨리 오르는지는 막대 색(오렌지/
    // 그린)만으로 표시했었다. 색약 사용자를 위해 방향 기호(▲/▼)도
    // 라벨에 같이 붙인다.
    const grouped = E.aggregateByGroup(result.contributions, SPEND_GROUPS)
      .sort((a, b) => b.contribution - a.contribution);

    // 기본 노출은 1~2위 요약 문장 + 랭킹 2개까지만. 나머지 순위와 계산
    // 과정(①②③)·막대그래프는 토글을 펼쳐야 보인다. grouped는 이미
    // contribution 내림차순.
    const rankRow = (g, i) => `
      <li class="rank-row ${g.rate >= official ? "is-hot" : "is-cool"}">
        <span class="rank-no">${i + 1}위</span>
        <span class="rank-name">${g.name}</span>
        <span class="rank-val">${g.contribution >= 0 ? "+" : ""}${g.contribution.toFixed(2)}포인트</span>
      </li>`;
    const ranked = grouped.filter((g) => g.amount > 0);
    const top2 = ranked.slice(0, 2);
    const rest = ranked.slice(2);
    $("#contribRank").innerHTML = top2.map((g, i) => rankRow(g, i)).join("");
    const moreToggle = $("#contribRankMore");
    if (rest.length) {
      moreToggle.hidden = false;
      $("#contribRankMoreList").innerHTML = rest.map((g, i) => rankRow(g, i + 2)).join("");
    } else {
      moreToggle.hidden = true;
    }

    const summary = $("#contribSummary");
    if (top2.length) {
      const first = top2[0];
      const monthlyExtra = first.amount * (first.rate / 100);
      summary.hidden = false;
      summary.innerHTML = `<b>${first.name}</b>${first.rate >= official
        ? `${josa(first.name, "이", "가")} 가장 많이 올랐어요`
        : `${josa(first.name, "은", "는")} 비중이 가장 커요`}
        (한 달에 약 ${man(Math.abs(monthlyExtra))}만원 ${monthlyExtra >= 0 ? "더" : "덜"} 나가요)`;
    } else {
      summary.hidden = true;
    }

    Charts.contributionChart($("#contribChart"),
      grouped.filter((g) => g.amount > 0).map((g) => ({
        ...g, examples: (SPEND_GROUPS.find((s) => s.id === g.id) || {}).examples,
        hot: g.rate >= official, color: g.rate >= official ? "var(--series-2)" : "var(--series-3)",
      })));
    renderCatLegend();
    renderContribMath(grouped, result, official);
    $("#mineSrc").textContent =
      `OECD 한국 소비자물가 COICOP 12분류 · ${result.month} 기준 · 브라우저에서 실시간 조회`;

    renderCumulative(result);
    renderMineAction(result, official);
  }

  function fallbackInsight(context) {
    if (context.gapPp > 0.05) {
      return `공식 평균보다 체감 물가가 높은 편이에요. ${context.topCategory} 지출을 조금 바꿔 보며 내 물가가 얼마나 달라지는지 확인해 보세요.`;
    }
    if (context.gapPp < -0.05) {
      return `공식 평균보다 체감 물가가 낮은 편이에요. 지금의 지출 구성이 장기 누적에서도 같은 흐름인지 아래 그래프로 함께 확인해 보세요.`;
    }
    return `지금의 지출 구성은 전국 평균과 비슷해요. 세부 지출을 실제 금액에 맞게 바꾸면 나에게 더 가까운 결과를 볼 수 있습니다.`;
  }

  async function openAIInsight() {
    const context = state.aiContext;
    if (!context) return;

    const dialog = $("#aiInsightDialog");
    const body = $("#aiInsightBody");
    const status = $("#aiInsightStatus");
    $("#aiOfficialRate").textContent = `${context.officialRate.toFixed(1)}%`;
    $("#aiPersonalRate").textContent = `${context.personalRate.toFixed(1)}%`;
    $("#aiTopCategory").textContent = context.topCategory;
    body.textContent = fallbackInsight(context);
    body.classList.add("is-loading");
    status.textContent = "Gemini가 계산 결과를 쉬운 말로 정리하고 있어요…";
    $("#aiRetryBtn").hidden = true;
    if (!dialog.open) dialog.showModal();

    const payload = {
      officialRate: context.officialRate,
      personalRate: context.personalRate,
      gapPp: context.gapPp,
      topCategoryId: context.topCategoryId,
      topSharePct: context.topSharePct,
      topRatePct: context.topRatePct,
    };
    const cacheKey = JSON.stringify(payload);
    if (state.aiCache.has(cacheKey)) {
      body.textContent = state.aiCache.get(cacheKey);
      body.classList.remove("is-loading");
      status.textContent = "Gemini 해설 · 계산은 연봉 성적표 엔진이 수행했습니다.";
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch("/api/insight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: cacheKey,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && typeof data.text === "string") {
        state.aiCache.set(cacheKey, data.text);
        body.textContent = data.text;
        status.textContent = "Gemini 해설 · 계산은 연봉 성적표 엔진이 수행했습니다.";
      } else if (response.status === 503) {
        // 서버에 AI 연결 자체가(API 키 등) 설정돼 있지 않은 상태 —
        // 다시 눌러도 같은 이유로 또 실패하니 재시도 버튼을 안 보여준다.
        status.textContent = "AI 해설 기능이 아직 준비되지 않았어요. 검증된 기본 해설을 보여드립니다.";
      } else {
        status.textContent = "AI 연결이 늦어 검증된 기본 해설을 보여드립니다.";
        $("#aiRetryBtn").hidden = false;
      }
    } catch (error) {
      status.textContent = error.name === "AbortError"
        ? "응답이 오래 걸려 자동으로 취소했어요. 다시 시도해 주세요."
        : "AI 연결이 늦어 검증된 기본 해설을 보여드립니다.";
      $("#aiRetryBtn").hidden = false;
    } finally {
      clearTimeout(timeout);
      body.classList.remove("is-loading");
    }
  }

  function renderCumulative(result) {
    const cats = state.cpi.categories;
    const mine = E.personalIndexPath(state.spending, cats);
    if (!mine) return;

    // 공식 지수도 같은 구간으로 잘라 100 기준으로 맞춘다
    const officialIdx = state.cpi.index;
    const months = mine.months.filter((m) => officialIdx[m] != null);
    if (months.length < 2) return;
    const oBase = officialIdx[months[0]];
    const officialPath = months.map((m) => ({
      x: E.monthToNum(m), y: (officialIdx[m] / oBase) * 100, meta: E.monthLabel(m),
    }));
    const minePath = mine.path
      .filter((p) => months.includes(p.month))
      .map((p) => ({ x: E.monthToNum(p.month), y: p.value, meta: E.monthLabel(p.month) }));

    const labels = [];
    const x0 = E.monthToNum(months[0]), x1 = E.monthToNum(months[months.length - 1]);
    for (let x = x0; x <= x1; x += 24) labels.push({ at: x, text: `${Math.floor(x / 12)}` });

    lineChart($("#cumChart"), {
      series: [
        { id: "official", label: "공식 물가", color: "var(--text-muted)", dashed: true, points: officialPath },
        { id: "mine", label: "내 물가", color: "var(--accent, #b76442)", points: minePath },
      ],
      xLabels: labels,
      yFormat: (val) => `${val.toFixed(0)}`,
    });

    $("#cumLegend").innerHTML =
      `<span class="legend-item"><span class="legend-swatch" style="background:var(--text-muted)"></span>공식 물가</span>
       <span class="legend-item"><span class="legend-swatch" style="background:var(--accent,#b76442)"></span>내 물가</span>`;

    const mineCum = mine.cumulative;
    const officialCum = officialIdx[months[months.length - 1]] / oBase - 1;
    const gap = mineCum - officialCum;
    const years = months.length / 12;

    // 10년 누적 차이를 실제 돈으로 환산하면 얼마인가
    const monthlySpend = result.total;
    const extraPerYear = monthlySpend * 12 * gap;

    $("#cumStats").innerHTML = `
      <div class="stat"><span class="k">내 물가 누적</span><span class="v">${signPct(mineCum, 1)}</span>
        <span class="s">${E.monthLabel(months[0])} ~ ${E.monthLabel(months[months.length - 1])}</span></div>
      <div class="stat"><span class="k">공식 물가 누적</span><span class="v">${signPct(officialCum, 1)}</span>
        <span class="s">같은 기간</span></div>
      <div class="stat ${gap > 0 ? "is-bad" : "is-good"}"><span class="k">차이</span>
        <span class="v">${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)}%p</span>
        <span class="s">${years.toFixed(0)}년 누적</span></div>
      <div class="stat ${gap > 0 ? "is-bad" : "is-good"}"><span class="k">돈으로 환산하면</span>
        <span class="v">${gap >= 0 ? "" : "−"}${man(Math.abs(extraPerYear))}만원</span>
        <span class="s">현재 지출 기준 연간 ${gap >= 0 ? "더 냄" : "덜 냄"}</span></div>`;

    // 현재 물가와 10년 누적의 방향이 엇갈릴 때가 있다. 화면만 보면 오류처럼
    // 보이므로 왜 그런지 짚어 준다. (예: 식료품은 지금 +0.9%지만 10년간 +43%)
    const nowDiff = state.personalRate - state.cpi.latest.yoy;
    const note = $("#cumNote");
    if (note) {
      if (nowDiff < -0.05 && gap > 0.005) {
        const cats = state.cpi.categories;
        const worst = [...cats]
          .filter((c) => (state.spending[c.id] || 0) > 0 && c.cum10y != null)
          .sort((a, b) => b.cum10y - a.cum10y)[0];
        note.hidden = false;
        note.className = "verdict warn";
        note.innerHTML = `지금은 공식 물가보다 낮은데, 10년 누적으로는 오히려 높습니다.
          ${worst ? `최근 ${worst.latest.yoy >= 0 ? "+" : ""}${worst.latest.yoy.toFixed(1)}%로 잠잠한
          <b>${worst.name}</b>${josa(worst.name, "이", "가")} 10년 동안은
          <b>+${worst.cum10y.toFixed(0)}%</b> 올랐기 때문입니다.` : ""}
          최근 한 달의 물가만 보면 놓치는 부분입니다.`;
      } else if (nowDiff > 0.05 && gap < -0.005) {
        note.hidden = false;
        note.className = "verdict";
        note.innerHTML = `지금은 공식 물가보다 높지만, 10년 누적으로는 낮습니다.
          최근 오른 품목에 지출이 몰려 있을 뿐 장기적으로는 유리한 구성이었습니다.`;
      } else {
        note.hidden = true;
      }
    }
  }

  function renderMineAction(result, official) {
    const rate = result.rate;
    const hl = E.halfLife(rate / 100);

    // 최소 연봉 인상액 — 퍼센트가 아니라 현재 연봉 기준 실제 금액으로.
    const cur = Math.max(0, +$("#curSalary").value || 0);
    const neededRaise = cur * (rate / 100);

    // 필요 투자 수익률 — 퍼센트는 유지하되, 이미 실데이터인 예금 자산의
    // CAGR과 비교해서 감이 오게 한다(하드코딩 금지 — state.market.assets에서
    // 그대로 읽는다). 목표 자산 탭에 입력된 보유 자산이 있으면 금액도 병기.
    const cashAsset = state.market.assets.find((a) => a.id === "cash");
    const cashRate = cashAsset ? cashAsset.cagr * 100 : null;
    const goalCurrent = Math.max(0, +$("#goalCurrent").value || 0);
    const compare = cashRate == null ? "굴려서 방어하려면"
      : rate > cashRate + 0.3 ? `일반 예금 금리(연 ${cashRate.toFixed(1)}%)보다 높은 수준`
      : rate < cashRate - 0.3 ? `일반 예금 금리(연 ${cashRate.toFixed(1)}%)보다 낮은 수준`
      : `일반 예금 금리(연 ${cashRate.toFixed(1)}%)와 비슷한 수준`;
    const goalCurrentNote = goalCurrent > 0
      ? ` · ${man(goalCurrent)}만원을 넣어뒀다면 1년에 약 ${man(goalCurrent * rate / 100)}만원은 불어나야 해요`
      : "";

    // 구매력 반감기 — 반감기 연수(hl) 계산은 그대로, 그 값을 사용자가
    // 입력한 실제 보유 자산에 곱해서 "숫자"로 와닿게 한다. 입력이 없으면
    // 100만원을 예시로 쓰되 "(예시)"라고 명시해 실제 값처럼 보이지 않게 한다.
    const rawCurrent = Math.max(0, +$("#goalCurrent").value || 0);
    const isReal = rawCurrent > 0;
    const base = isReal ? rawCurrent : 100;
    const half = base / 2;

    $("#mineActionStats").innerHTML = `
      <div class="stat"><span class="k">최소 연봉 인상액</span><span class="v">약 ${man(neededRaise)}만원</span>
        <span class="s">이만큼은 올라야 본전 (${rate.toFixed(1)}%)</span></div>
      <div class="stat"><span class="k">필요 투자 수익률</span><span class="v">${rate.toFixed(1)}%</span>
        <span class="s">${compare}${goalCurrentNote}</span></div>
      <div class="stat ${hl && hl < 20 ? "is-warn" : ""}"><span class="k">구매력 반감기</span>
        <span class="v">${hl ? `약 ${man(half)}만원` : "—"}</span>
        <span class="s">${hl ? `${hl.toFixed(0)}년 뒤, 지금 ${man(base)}만원${isReal ? "" : "(예시)"}의 가치` : "지금 돈의 가치가 절반 되는 시점"}</span></div>`;

    const a = $("#mineAction");
    a.className = "verdict";
    a.innerHTML = `내 물가 <b>${rate.toFixed(1)}%</b>를 넘기려면 연봉을 그만큼 올려받거나,
      연 <b>${rate.toFixed(1)}%</b> 이상으로 굴려야 합니다. 아무것도 안 하면
      지금 가진 ${man(base)}만원${isReal ? "" : "(예시)"}은 ${hl ? hl.toFixed(0) : "—"}년 뒤
      약 ${man(half)}만원 가치가 됩니다.`;
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
      $("#salaryChart").innerHTML = `<p class="skeleton">${guide}</p>`;
      $("#trendChart").innerHTML = `<p class="skeleton">현재 연봉을 입력하면 격차가 어떻게 벌어지는지 계산합니다.</p>`;
      $("#trendLegend").innerHTML = "";
      $("#gapStats").innerHTML = "";
      $("#negoStats").innerHTML = "";
      $("#gapVerdict").className = "verdict";
      $("#gapVerdict").textContent = guide;
      $("#trendVerdict").className = "verdict";
      $("#trendVerdict").textContent = guide;
      $("#negoVerdict").className = "verdict";
      $("#negoVerdict").textContent = guide;
      return;
    }

    const d = E.diagnose({ curSalary: cur, nextSalary: next, inflationPct: state.inflation });

    // 막대 3개
    barChart($("#salaryChart"), [
      { label: "현재 연봉", value: cur, color: "var(--baseline)" },
      { label: "내년 연봉", value: next, color: "var(--series-1)",
        sub: `명목 ${d.nominalRatePct >= 0 ? "+" : ""}${d.nominalRatePct.toFixed(1)}%` },
      { label: "물가 유지선", value: d.requiredSalary, color: d.beatsInflation ? "var(--good)" : "var(--critical)",
        sub: `물가 +${state.inflation.toFixed(1)}%`,
        subColor: d.beatsInflation ? "var(--good-text)" : "var(--critical-text)" },
    ]);

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
        <span class="v">${man(Math.abs(d.gap))}만원</span>
        <span class="s">월 ${man(Math.abs(d.monthlyGap))}만원</span></div>
      <div class="stat"><span class="k">내년 연봉으로 실제 살 수 있는 만큼</span>
        <span class="v">${man(d.realValue)}만원</span>
        <span class="s">올해 물가 기준</span></div>
      ${workdayStat(next, d)}`;

    const v = $("#gapVerdict");
    if (d.beatsInflation) {
      v.className = "verdict";
      v.innerHTML = `내년 연봉 <b>${man(next)}만원</b>은 물가 유지선(${man(d.requiredSalary)}만원)을
        <b>${man(-d.gap)}만원 넘어섭니다.</b> 실질 소득이 늘어나는 구간입니다.`;
    } else {
      const days = next > 0 ? d.gap / (next / WORKDAYS_PER_YEAR) : 0;
      v.className = d.gap > cur * 0.03 ? "verdict bad" : "verdict warn";
      v.innerHTML = `물가를 따라가려면 <b>${man(d.requiredSalary)}만원</b>이 필요한데
        내년 연봉은 ${man(next)}만원입니다. 연 <b>${man(d.gap)}만원</b>(월 ${man(d.monthlyGap)}만원)이 부족합니다.
        <b>작년과 같은 생활을 하려면 ${days.toFixed(1)}일을 더 일해야 하는 셈입니다.</b>`;
    }

    renderTrend(cur, next, d);
    renderNegotiation(cur, d);
  }

  /* 격차는 해마다 벌어진다 — 명목 인상률과 물가가 유지될 때의 두 곡선.
     (bumyong 프로토타입의 연도별 추이 관점을 실데이터 기준으로 다시 만듦) */
  function renderTrend(cur, next, d) {
    const YEARS = 10;
    const raise = cur > 0 ? (next - cur) / cur : 0;
    const infl = state.inflation / 100;

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
        { id: "required", label: "물가 유지선", color: "var(--critical)", dashed: true, points: required },
      ],
      xLabels: labels,
      yFormat: (v) => `${man(v / 1000) / 10}억`,
    });

    $("#trendLegend").innerHTML =
      `<span class="legend-item"><span class="legend-swatch" style="background:var(--series-1)"></span>내 연봉 (인상률 ${(raise * 100).toFixed(1)}%)</span>
       <span class="legend-item"><span class="legend-swatch" style="background:var(--critical)"></span>물가 유지선 (${state.inflation.toFixed(1)}%)</span>`;

    const endGap = required[YEARS].y - nominal[YEARS].y;
    const v = $("#trendVerdict");
    if (endGap <= 0) {
      v.className = "verdict";
      v.innerHTML = `인상률이 물가를 앞서고 있어 격차가 <b>벌어지지 않습니다.</b>
        10년 뒤에는 오히려 <b>${man(-endGap)}만원</b> 앞섭니다.`;
    } else {
      v.className = "verdict bad";
      v.innerHTML = `지금 조건이 유지되면 10년 뒤 격차는 <b>연 ${man(endGap)}만원</b>까지 벌어집니다.
        매년 <b>${(state.inflation - d.nominalRatePct).toFixed(1)}포인트</b>씩 밀리는 게 복리로 쌓인 결과입니다.`;
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
      `실제 월말 종가 ${src ? src.range[0] : ""}~${src ? src.range[1] : ""} 기준 · ` +
      `예금은 OECD 한국 3개월 은행간금리 (최근 ${state.market.deposit_rate_latest}%)`;
  }

  function renderNegotiation(cur, d) {
    const n = E.negotiate({
      curSalary: cur, inflationPct: state.inflation,
      offeredRatePct: d.nominalRatePct, desiredRealRatePct: 1,
    });
    const defendAmount = cur * (state.inflation / 100);
    const offeredAmount = cur * (d.nominalRatePct / 100);
    const targetAmount = n.targetSalary - cur;
    $("#negoStats").innerHTML = `
      <div class="stat"><span class="k">물가 방어 최소 인상액</span><span class="v">${man(defendAmount)}만원</span>
        <span class="s">최소 기준선 (${state.inflation.toFixed(1)}%)</span></div>
      <div class="stat"><span class="k">실질 +1% 목표 인상액</span><span class="v">${man(targetAmount)}만원</span>
        <span class="s">목표 연봉 ${man(n.targetSalary)}만원 (${n.targetRatePct.toFixed(1)}%)</span></div>
      <div class="stat"><span class="k">제안받은 인상액</span><span class="v">${man(offeredAmount)}만원</span>
        <span class="s">현재 입력값 (${d.nominalRatePct.toFixed(1)}%)</span></div>
      <div class="stat ${n.shortfallPp <= 0 ? "is-good" : "is-warn"}"><span class="k">차이</span>
        <span class="v">${n.shortfallPp <= 0 ? "달성" : `${man(n.shortfallAmount)}만원 부족`}</span>
        <span class="s">${n.shortfallPp <= 0 ? "목표 이상" : `${n.shortfallPp.toFixed(1)}포인트 차이`}</span></div>`;

    const v = $("#negoVerdict");
    if (n.shortfallPp <= 0) {
      v.className = "verdict";
      v.innerHTML = `제안받은 <b>${man(offeredAmount)}만원</b>(${d.nominalRatePct.toFixed(1)}%)은 물가에 실질 +1%를 더한 목표선을 이미 넘었습니다.`;
    } else {
      v.className = "verdict warn";
      v.innerHTML = `협상 테이블에서 말할 숫자는 <b>${man(targetAmount)}만원</b>(연봉 ${man(n.targetSalary)}만원, ${n.targetRatePct.toFixed(1)}%)입니다.
        물가 방어분 ${man(defendAmount)}만원에 실질 인상 1%를 더한 값이고, 현재 제안과는 ${man(n.shortfallAmount)}만원 차이입니다.`;
    }
  }

  /* ══════════════ 탭 2 · 목표 자산 ══════════════ */
  function setupGoalTab() {
    ["#goalAmount", "#goalYears", "#goalMonths", "#goalCurrent", "#goalMonthly"].forEach((sel) =>
      $(sel).addEventListener("input", renderGoal));
  }

  function renderGoal() {
    const goal = Math.max(0, +$("#goalAmount").value || 0);
    const { years, months } = readGoalDuration();
    const current = Math.max(0, +$("#goalCurrent").value || 0);
    const monthly = Math.max(0, +$("#goalMonthly").value || 0);
    $("#goalMonthlyVal").textContent = `${man(monthly)}만원`;

    const err = $("#goalErr");
    if (goal <= current) {
      err.textContent = "목표 금액이 현재 보유 자산보다 크지 않습니다.";
      err.hidden = false;
    } else { err.hidden = true; }

    // 목표는 설문에서 선택 문항이라 건너뛰기 쉽다. 그때 0으로만 채워
    // "0만원이면 0만원으로 목표를 0만원 넘어섭니다" 같은 문장이 나왔다.
    // 고장으로 보이므로, 왜 비었는지와 무엇을 하면 되는지 알려 준다.
    if (goal <= 0) {
      const guide = "목표 금액을 입력하면 매달 얼마를 모아야 하는지 계산해 드려요.";
      $("#goalStats").innerHTML = "";
      $("#goalScenarioTable").innerHTML = "";
      $("#growthChart").innerHTML = `<p class="skeleton">${guide}</p>`;
      $("#goalScenarioChart").innerHTML =
        `<p class="skeleton">목표를 정하면 투자 성향별로 필요한 저축액을 비교해 드려요.</p>`;
      $("#goalVerdict").className = "verdict";
      $("#goalVerdict").textContent = guide;
      $("#goalRiskNote").textContent = "";
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
      if (input.value) { state.startMonth = input.value; renderTime(); }
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

  function renderTime() {
    const amount = Math.max(0, +$("#investAmount").value || 0);
    const start = state.startMonth;
    const picked = state.market.assets.filter((a) => state.picks.has(a.id));

    if (!picked.length) {
      $("#timeStats").innerHTML = "";
      $("#timeChart").innerHTML = `<p class="skeleton">자산을 하나 이상 선택해 주세요.</p>`;
      $("#timeTable").innerHTML = "";
      $("#timeVerdict").textContent = "—";
      $("#timeLegend").innerHTML = "";
      $("#timingTable").innerHTML = "";
      $("#timingVerdict").textContent = "자산을 하나 이상 선택해 주세요.";
      return;
    }

    const results = picked.map((a) => ({ asset: a, bt: E.backtest(a, start, amount) }))
      .filter((r) => r.bt);
    if (!results.length) {
      $("#timeChart").innerHTML = `<p class="skeleton">투자금액을 입력하고, 데이터가 있는 시작 시점을 골라 주세요.</p>`;
      $("#timingTable").innerHTML = "";
      $("#timingVerdict").textContent = "계산할 수 있는 실제 관측치가 없습니다.";
      return;
    }

    const infl = E.inflationPath(state.cpi.index, start, amount);
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
      ${best.asset.name}은 지금 <b>${man(best.bt.finalValue)}만원</b>입니다
      (연평균 ${signPct(best.bt.cagr)}, 최대 낙폭 ${signPct(best.bt.mdd)}).
      선택한 ${results.length}개 중 <b>${beat.length}개</b>가 같은 기간 물가상승을 이겼습니다.
      다만 이것은 선택한 한 시작 달의 기록이지, 앞으로의 수익을 약속하는 숫자는 아닙니다.`;

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
      `Yahoo Finance 월말 종가 · 물가는 OECD 한국 CPI · 스냅샷 ${state.market.source_fetched_at.slice(0, 10)}`;

    // 표
    $("#timeTable").innerHTML = sorted.map((r) => `
      <tr>
        <td><span class="legend-swatch" style="background:${colorOf(r.asset.id)};display:inline-block;margin-right:.4rem"></span>${r.asset.name}
          ${r.asset.krw_converted ? '<span class="risk-badge risk-mid">원화환산</span>' : ""}</td>
        <td class="num">${signPct(r.bt.totalReturn)}</td>
        <td class="num">${signPct(r.bt.cagr)}</td>
        <td class="num">${pct(r.asset.volatility)}</td>
        <td class="num">${signPct(r.bt.mdd)}</td></tr>`).join("");

    renderTiming(results, amount, start);
  }

  function renderTiming(results, amount, start) {
    const windows = results.map((r) => ({
      asset: r.asset,
      result: E.backtestWindow(r.asset, start, amount, 6),
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
          ? '<span class="risk-badge risk-low">브라우저에서 실시간 조회</span>'
          : `<span class="risk-badge risk-mid">일 1회 스냅샷</span> <span style="color:var(--text-muted)">${s.reason || ""}</span>`);
      return `<li><strong><a href="${s.url}">${s.name} ↗</a></strong>
        — ${s.use} ${badge}</li>`;
    }).join("");

    const clean = state.meta.notes || [];
    $("#cleanList").innerHTML = clean.length
      ? clean.map((n) => `<li>${n}</li>`).join("")
      : `<li>이번 수집분에서 제외된 값은 없습니다.</li>`;

    $("#assumeList").innerHTML = state.meta.assumptions.map((a) => `<li>${a}</li>`).join("");

    const gen = new Date(state.meta.generated_at);
    $("#buildInfo").classList.remove("skeleton-bar");
    $("#buildInfo").textContent =
      `데이터 갱신 ${gen.toLocaleString("ko-KR")} · 물가·환율·비트코인은 실시간 조회, 시세 시계열은 주 1회 수집한 스냅샷입니다.`;
  }

  /* ══════════════ 전체 렌더 ══════════════ */
  function renderAll() {
    if (!state.market) return;
    renderMine();
    renderGap();
    renderGoal();
    renderTime();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
