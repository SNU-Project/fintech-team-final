/* ============================================================
   화면 조립 — 데이터 로드, 입력 바인딩, 렌더링
   ============================================================ */
(function () {
  "use strict";

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
  const man1 = (n) => Number(n).toLocaleString("ko-KR", { maximumFractionDigits: 1 });
  const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;
  const signPct = (n, d = 1) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;

  const ASSET_COLOR = {
    cash: "var(--series-1)", bond10y: "var(--series-3)", kodex200: "var(--series-2)",
    sp500: "var(--series-4)", gold: "var(--series-5)", bitcoin: "var(--series-6)",
  };
  const colorOf = (id) => ASSET_COLOR[id] || "var(--text-muted)";

  const PERSONA_DATA = window.Personas;
  const PERSONAS = PERSONA_DATA.profiles;
  const DEFAULT_PERSONA = "solo";
  const spendingTotal = (spending) =>
    Object.values(spending).reduce((sum, value) => sum + (Number(value) || 0), 0);

  // 총액은 체감하기 쉬운 입력이고, 개인 물가는 지출 비중으로 계산된다.
  // 그래서 총액을 바꿀 때는 통계에서 온 비중을 유지한 채 모든 항목을 같이 조정한다.
  function scaleSpending(spending, nextTotal) {
    const current = spendingTotal(spending);
    if (current <= 0 || nextTotal <= 0) {
      return Object.fromEntries(Object.keys(spending).map((key) => [key, 0]));
    }
    const scale = nextTotal / current;
    const scaled = Object.fromEntries(Object.entries(spending).map(([key, value]) =>
      [key, Math.round(value * scale * 10) / 10]));
    // 항목별 0.1만 원 반올림 뒤 생기는 오차는 가장 큰 항목에 합쳐
    // 사용자가 입력한 총액과 화면 합계가 정확히 같게 만든다.
    const largest = Object.keys(scaled).sort((a, b) => scaled[b] - scaled[a])[0];
    const roundingGap = Math.round((nextTotal - spendingTotal(scaled)) * 10) / 10;
    if (largest && roundingGap) {
      scaled[largest] = Math.max(0, Math.round((scaled[largest] + roundingGap) * 10) / 10);
    }
    return scaled;
  }

  const state = {
    market: null, cpi: null, meta: null,
    risk: "balanced", goalRisk: "balanced",
    inflation: 2.8, inflationLive: false,
    picks: new Set(["kodex200", "sp500", "gold"]),
    startMonth: null,
    spending: { ...PERSONAS[DEFAULT_PERSONA].spending },
    persona: DEFAULT_PERSONA,
    personalRate: null,
    aiContext: null,
    aiCache: new Map(),
  };

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
    $("#inflation").value = state.inflation.toFixed(1);

    setupTabs();
    setupMineTab();
    setupGapTab();
    setupGoalTab();
    setupTimeTab();
    // 월 투자 가능액(실질임금 진단)과 월 저축 가능액(목표 자산)은 같은 값으로 시작한다.
    $("#goalMonthly").value = $("#budget").value;
    setupHomeFlow();
    setupShareCard();
    setupFinalConclusion();
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
      $("#inflation").value = d.value.toFixed(1);
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
    if (res.btc.ok) {
      const d = res.btc.data;
      const dir = d.delta == null ? "" :
        `<span class="delta ${d.delta >= 0 ? "up" : "down"}">${d.delta >= 0 ? "▲" : "▼"}${Math.abs(d.delta).toFixed(2)}%</span>`;
      $("#btcLiveNote").hidden = false;
      $("#btcLiveNote").innerHTML =
        `<span class="live-dot" style="display:inline-block;vertical-align:middle"></span>
         실시간 비트코인 시세 <b>${man(d.value / 10000)}만원</b> ${dir} (24시간)`;
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
      <span class="lbl">매일 자동 갱신</span></span>`);

    $("#ticker").innerHTML = items.join("");
  }

  /* ══════════════ 탭 ══════════════ */
  // 탭은 더 이상 패널을 숨기지 않는다 — 내 물가부터 자산 타임머신까지
  // 전부 리포트처럼 항상 이어져 보이고, 탭은 그 안의 위치로 스크롤만
  // 시켜주는 앵커 링크(<a href="#panel-x">)다. 여기서는 지금 화면에
  // 걸쳐 있는 섹션이 어떤 탭인지만 aria-current로 표시해 준다.
  function setupTabs() {
    const tabs = $$(".tab");
    const tabBySection = new Map(tabs.map((t) => [t.getAttribute("href").slice(1), t]));
    const sections = $$(".panel").filter((p) => tabBySection.has(p.id));

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        tabs.forEach((t) => t.removeAttribute("aria-current"));
        tabBySection.get(entry.target.id).setAttribute("aria-current", "true");
      });
    }, { rootMargin: "-40% 0px -55% 0px", threshold: 0 });

    sections.forEach((s) => observer.observe(s));
  }

  /* ══════════════ 홈 · 온보딩 → 로딩 → 요약 ══════════════
     Q1~Q5을 순서대로 물어보고, 답을 각 섹션의 실제 입력(persona 버튼·
     월 생활비·연봉 필드·투자성향 세그먼트·목표 필드)에 그대로 반영한다.
     설문 중에는 리포트 4개 섹션과 탭을 전부 숨겨 둔다 — 아직 안 끝난
     설문 아래로 결과가 미리 보이면 안 된다. 설문을 마치면(또는
     재방문자면) 한꺼번에 드러낸다. 한 번 마치면 localStorage에 저장해
     재방문 시 다시 묻지 않는다. */
  const ONBOARD_KEY = "salarygap-profile";
  const TOTAL_STEPS = 5;
  const REPORT_PANEL_IDS = ["panel-mine", "panel-gap", "panel-goal", "panel-time", "panel-final"];

  function setReportVisible(visible) {
    REPORT_PANEL_IDS.forEach((id) => { $(`#${id}`).hidden = !visible; });
    $("#mainTabs").hidden = !visible;
    $("#ticker").hidden = !visible;
    $("#basis").hidden = !visible;
  }

  const personaDefaultTotal = (persona) =>
    spendingTotal((PERSONAS[persona] || PERSONAS[DEFAULT_PERSONA]).spending);

  function setInputAndFire(sel, value) {
    if (value == null) return;
    $(sel).value = value;
    $(sel).dispatchEvent(new Event("input", { bubbles: true }));
  }

  function freshDraft() {
    return {
      persona: DEFAULT_PERSONA,
      monthlySpend: personaDefaultTotal(DEFAULT_PERSONA),
      curSalary: 3600, nextSalary: 3750,
      risk: "balanced",
      goalAmount: 5000, goalYears: 3, goalCurrent: 800,
    };
  }

  // 문항에서 받은 답을 실제 리포트 입력(내 물가·실질임금 진단·목표 자산)에
  // 그대로 반영한다. persona부터 눌러야 월 생활비 스케일링이 그 지출
  // 비중을 기준으로 계산된다.
  function applyOnboardProfile(profile) {
    const personaBtn = $(`#personaSeg button[data-persona="${profile.persona || DEFAULT_PERSONA}"]`);
    if (personaBtn) personaBtn.click();

    if (profile.monthlySpend != null) setInputAndFire("#monthlySpend", profile.monthlySpend);
    setInputAndFire("#curSalary", profile.curSalary);
    setInputAndFire("#nextSalary", profile.nextSalary);
    setInputAndFire("#goalAmount", profile.goalAmount);
    setInputAndFire("#goalYears", profile.goalYears);
    setInputAndFire("#goalCurrent", profile.goalCurrent);

    if (profile.risk) {
      const riskBtn = $(`#riskSeg button[data-risk="${profile.risk}"]`);
      if (riskBtn) riskBtn.click();
      const goalRiskBtn = $(`#goalRiskSeg button[data-risk="${profile.risk}"]`);
      if (goalRiskBtn) goalRiskBtn.click();
    }
    renderAll();
  }

  // 리포트 맨 위에 놓을 한 줄 요약 — "당신의 체감 물가는 2.9%, 공식보다 0.1%p 높아요"
  function homeSummaryText() {
    const rate = state.personalRate;
    if (rate == null) return { headline: "물가를 계산할 수 없어요" };
    return { headline: `당신의 체감 물가는 ${rate.toFixed(1)}%` };
  }

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

    const goalAmount = Math.max(0, +$("#goalAmount").value || 0);
    const goalYears = Math.max(1, Math.min(40, +$("#goalYears").value || 1));
    const goalCurrent = Math.max(0, +$("#goalCurrent").value || 0);
    const goalMonthly = Math.max(0, +$("#goalMonthly").value || 0);
    if (goalAmount > goalCurrent) {
      const plan = E.planOf(state.market, state.goalRisk);
      if (plan) {
        const path = E.project({ initial: goalCurrent, monthly: goalMonthly, months: goalYears * 12, annualReturn: plan.expected_return });
        const gdiff = path[path.length - 1].value - goalAmount;
        lines.push(gdiff >= 0
          ? `지금 페이스를 유지하면 목표 자산에도 ${goalYears}년 뒤 ${man(gdiff)}만원 여유 있게 도착할 것 같아요.`
          : `다만 지금 페이스로는 목표 자산에 ${man(-gdiff)}만원 정도 못 미칠 것으로 보여요.`);
      }
    }

    lines.push("아래에서 하나씩 풀어드릴게요.");
    return lines.join("\n");
  }

  // 문장이 한 글자씩 나타나는 연출 — 결과를 "읽어주는" 느낌을 준다.
  // 요약 화면 문단과 마지막 결론 문단, 두 곳에서 동시에 쓰일 수 있어
  // 타이머를 변수 하나로 공유하면 한쪽이 다른 쪽을 끊어버릴 수 있다.
  // WeakMap으로 대상 엘리먼트마다 자기 타이머를 따로 가지게 한다.
  const typewriterTimers = new WeakMap();
  function typewriter(el, text, speed = 22) {
    const prev = typewriterTimers.get(el);
    if (prev) { clearInterval(prev.interval); clearTimeout(prev.watchdog); }
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
    const finish = () => {
      clearInterval(interval);
      clearTimeout(watchdog);
      el.textContent = text;
      el.classList.remove("typing-cursor");
      typewriterTimers.delete(el);
    };
    // 매 tick마다 1글자씩 더하는 대신 "시작 시각 대비 몇 글자째여야 하는가"를
    // 계산한다. 탭이 백그라운드로 갔다 온 직후처럼 브라우저가 setInterval을
    // 오래 지연시켰다 몰아서 재개하는 상황에서도, 다음 tick이 흐른 시간만큼
    // 알아서 따라잡아 자연스럽게 이어진다 (카운트업 방식은 이런 지연을
    // 그대로 누적시켜 끝에 안 닿고 멈춘 것처럼 보일 수 있었다).
    const interval = setInterval(() => {
      const i = Math.floor((Date.now() - start) / speed);
      if (i >= text.length) { finish(); return; }
      el.textContent = text.slice(0, i);
    }, speed);
    // 위 tick 자체가 어떤 이유로든 더 이상 안 불리는 극단적인 경우를 대비한
    // 최후의 안전장치 — 예상 완료 시각이 지나면 무조건 전체 문장을 채우고
    // 커서를 지운다. 커서가 영원히 깜빡이며 멈춰 있는 상태는 없어야 한다.
    const watchdog = setTimeout(finish, text.length * speed + 2000);
    typewriterTimers.set(el, { interval, watchdog });
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

    const plans = Object.keys(state.market.portfolios).map((k) => E.planOf(state.market, k));
    const enough = plans.filter((p) => p.expected_return * 100 >= rate);
    const minPlan = enough.length ? enough[0] : null;
    lines.push(minPlan
      ? `체감 물가 ${rate.toFixed(1)}%를 방어하려면 최소 ${minPlan.label} 이상의 포트폴리오가 필요해요.`
      : `체감 물가 ${rate.toFixed(1)}%는 적극형 포트폴리오로도 방어가 쉽지 않은 수준이에요.`);

    const cur = Math.max(0, +$("#curSalary").value || 0);
    const next = Math.max(0, +$("#nextSalary").value || 0);
    if (cur > 0) {
      const d = E.diagnose({ curSalary: cur, nextSalary: next, inflationPct: state.inflation });
      lines.push(d.beatsInflation
        ? "내년 연봉은 물가를 이기고 있어서, 지금 페이스라면 실질 소득은 지켜지고 있어요."
        : "내년 연봉은 물가를 다 따라가지 못하고 있어서, 그 차이를 투자나 협상으로 메워야 해요.");
    }

    const goalAmount = Math.max(0, +$("#goalAmount").value || 0);
    const goalYears = Math.max(1, Math.min(40, +$("#goalYears").value || 1));
    const goalCurrent = Math.max(0, +$("#goalCurrent").value || 0);
    const goalMonthly = Math.max(0, +$("#goalMonthly").value || 0);
    if (goalAmount > goalCurrent) {
      const plan = E.planOf(state.market, state.goalRisk);
      if (plan) {
        const months = goalYears * 12;
        const path = E.project({ initial: goalCurrent, monthly: goalMonthly, months, annualReturn: plan.expected_return });
        const gdiff = path[path.length - 1].value - goalAmount;
        if (gdiff >= 0) {
          lines.push(`목표 자산도 지금 페이스로 ${goalYears}년 안에 닿을 것으로 보여요.`);
        } else {
          const need = Math.ceil(E.requiredMonthly({ goal: goalAmount, current: goalCurrent, months, annualReturn: plan.expected_return }));
          lines.push(`목표 자산에 닿으려면 월 저축액을 ${man(need)}만원 정도로 올리거나, 기간을 늘리는 방법을 함께 고려해볼 만해요.`);
        }
      }
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
    function scrollHomeToTop() {
      $("#panel-home").scrollIntoView({ behavior: "auto", block: "start" });
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
      if (i === 2) $("#onbMonthlySpend").value = draft.monthlySpend;
      scrollHomeToTop();
    }

    function renderSummary() {
      const { headline } = homeSummaryText();
      $("#homeSummaryHeadline").textContent = headline;
      typewriter($("#homeSummarySub"), buildNarrative());
      summaryView.hidden = false;
      // 첫 화면에는 타이틀·설명·시작하기만 보여야 한다. 리포트 4개 섹션과
      // 탭은 설문이 끝나고 포트폴리오가 준비된 뒤에야 의미가 생기므로
      // 그때 한꺼번에 드러낸다.
      setReportVisible(true);
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
        $$("#onbPersonaGrid button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      });
    });
    $("#onbNext1").addEventListener("click", () => showStep(2));

    // ---- 2 · 월 생활비 ----
    $("#onbNext2").addEventListener("click", () => {
      draft.monthlySpend = Math.max(0, +$("#onbMonthlySpend").value || 0);
      showStep(3);
    });

    // ---- 3 · 연봉 ----
    $("#onbNext3").addEventListener("click", () => {
      draft.curSalary = Math.max(0, +$("#onbCurSalary").value || 0);
      draft.nextSalary = Math.max(0, +$("#onbNextSalary").value || 0);
      showStep(4);
    });

    // ---- 4 · 투자 성향 (건너뛰기 가능) ----
    $$("#onbRiskSeg button").forEach((b) => {
      b.addEventListener("click", () => {
        draft.risk = b.dataset.risk;
        $$("#onbRiskSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      });
    });
    $("#onbNext4").addEventListener("click", () => showStep(5));
    $("#onbSkip4").addEventListener("click", () => showStep(5));

    // ---- 5 · 목표 자산 (건너뛰기 가능 — 기본값 그대로 완료) ----
    function collectGoalAndFinish() {
      draft.goalAmount = Math.max(0, +$("#onbGoalAmount").value || 0);
      draft.goalYears = Math.max(1, Math.min(40, +$("#onbGoalYears").value || 1));
      draft.goalCurrent = Math.max(0, +$("#onbGoalCurrent").value || 0);
      finish(draft);
    }
    $("#onbFinish").addEventListener("click", collectGoalAndFinish);
    $("#onbSkip5").addEventListener("click", collectGoalAndFinish);

    // ---- 뒤로가기 (모든 문항 공통) ----
    $$("[data-back]").forEach((b) => {
      b.addEventListener("click", () => showStep(Math.max(0, stepIndex - 1)));
    });

    // ---- 요약 화면 ----
    $("#homeReportBtn").addEventListener("click", () => $("#tab-mine").click());
    $("#homeRestartBtn").addEventListener("click", () => {
      // 바로 위 "공유 카드 만들기" 버튼과 가까이 있어 오클릭하기 쉬운데,
      // 이 버튼은 지금까지 입력한 값을 전부 날리는 되돌릴 수 없는 동작이라
      // 한 번 더 확인한다.
      if (!confirm("처음부터 다시 입력할까요? 지금까지 입력한 내용은 모두 사라져요.")) return;
      localStorage.removeItem(ONBOARD_KEY);
      summaryView.hidden = true;
      setReportVisible(false);
      draft = freshDraft();
      $$("#onbPersonaGrid button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.persona === DEFAULT_PERSONA)));
      $$("#onbRiskSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.risk === "balanced")));
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

  /* ══════════════ 탭 0 · 내 물가 ══════════════ */
  function syncSpendingFields(cats, syncTotal = true) {
    cats.forEach((c) => {
      const input = $(`#sp-${c.id}`);
      if (input) input.value = (state.spending[c.id] || 0).toFixed(1).replace(/\.0$/, "");
    });
    if (syncTotal) {
      $("#monthlySpend").value = spendingTotal(state.spending).toFixed(1).replace(/\.0$/, "");
    }
  }

  function renderPersonaBasis() {
    const source = PERSONA_DATA.source;
    const p = state.persona ? PERSONAS[state.persona] : null;
    $("#personaBasis").innerHTML = p
      ? `<b>${p.basis}</b>으로 채웠습니다. 개인 상황에 맞게 바꿀 수 있습니다.<br>
         <a href="${source.url}">${source.label} · ${source.table} ↗</a>`
      : `세부 금액을 직접 수정한 상태입니다.<br>
         시작값 출처: <a href="${source.url}">${source.label} ↗</a>`;
  }

  function applyPersona(key, cats) {
    const p = PERSONAS[key];
    if (!p) return;
    state.persona = key;
    state.spending = { ...p.spending };
    $$("#personaSeg button").forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.persona === key)));
    syncSpendingFields(cats);
    renderPersonaBasis();
    renderMine();
  }

  function setupMineTab() {
    const cats = state.cpi.categories || [];
    if (!cats.length) {
      $("#panel-mine").innerHTML =
        `<div class="load-error">품목별 물가 데이터가 없습니다. 파이프라인을 다시 실행해 주세요.</div>`;
      return;
    }

    const row = (c) => {
      return `<div class="spend-row">
        <label for="sp-${c.id}">
          <b>${c.name}</b>
          <small>${c.hint}</small>
        </label>
        <span class="input-wrap">
          <input type="number" id="sp-${c.id}" min="0" step="1" inputmode="decimal" value="${state.spending[c.id] ?? 0}">
          <span>만원</span>
        </span>
      </div>`;
    };

    $("#spendFields").innerHTML = cats.map(row).join("");

    cats.forEach((c) => {
      $(`#sp-${c.id}`).addEventListener("input", (e) => {
        state.spending[c.id] = Math.max(0, +e.target.value || 0);
        $$("#personaSeg button").forEach((b) => b.setAttribute("aria-pressed", "false"));
        state.persona = null;
        $("#monthlySpend").value = spendingTotal(state.spending).toFixed(1).replace(/\.0$/, "");
        renderPersonaBasis();
        renderMine();
      });
    });

    $$("#personaSeg button").forEach((b) => {
      b.addEventListener("click", () => {
        applyPersona(b.dataset.persona, cats);
      });
    });

    $("#monthlySpend").addEventListener("input", (e) => {
      const nextTotal = Math.max(0, +e.target.value || 0);
      const base = spendingTotal(state.spending) > 0
        ? state.spending
        : (state.persona ? PERSONAS[state.persona].spending : PERSONAS[DEFAULT_PERSONA].spending);
      state.spending = scaleSpending(base, nextTotal);
      syncSpendingFields(cats, false);
      renderMine();
    });

    syncSpendingFields(cats);
    renderPersonaBasis();

    $("#applyToSalary").addEventListener("click", () => {
      if (state.personalRate == null) return;
      state.inflation = state.personalRate;
      state.inflationLive = false;
      $("#inflation").value = state.personalRate.toFixed(1);
      $("#inflSource").innerHTML =
        `<b>내 물가 ${state.personalRate.toFixed(1)}%</b>를 적용했습니다. ` +
        `공식 물가(${state.cpi.latest.yoy.toFixed(1)}%) 대신 내 지출 기준으로 진단합니다.`;
      renderGap();
      $("#tab-gap").click();
      // 탭 전환 + 작은 안내 문구만으로는 값이 실제로 넘어갔는지 확신하기 어렵다는
      // 피드백이 있어, 적용된 필드를 잠깐 반짝여 눈에 띄게 한다.
      const inflLabel = $("#inflLabel");
      inflLabel.classList.remove("field-flash");
      void inflLabel.offsetWidth;
      inflLabel.classList.add("field-flash");
      setTimeout(() => inflLabel.classList.remove("field-flash"), 1800);
    });

    $("#aiExplainBtn").addEventListener("click", openAIInsight);
    $("#aiRetryBtn").addEventListener("click", openAIInsight);
    $("#aiCloseBtn").addEventListener("click", () => $("#aiInsightDialog").close());
    $("#aiInsightDialog").addEventListener("click", (event) => {
      if (event.target === $("#aiInsightDialog")) $("#aiInsightDialog").close();
    });
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
      $("#spendTotal").textContent = "0만원";
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
    $("#spendTotal").textContent = `${man1(result.total)}만원`;
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
      mid.className = "vs-mid over"; mid.textContent = `+${diff.toFixed(1)}%p 높음`;
      side.classList.remove("under");
    } else {
      mid.className = "vs-mid under"; mid.textContent = `${diff.toFixed(1)}%p 낮음`;
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
      v.innerHTML = `당신의 물가는 공식 통계보다 <b>${diff.toFixed(1)}%p 높습니다.</b>
        가장 크게 밀어올린 건 <b>${top.name}</b>(지출의 ${(top.weight * 100).toFixed(0)}%,
        이 품목만 ${top.rate >= 0 ? "+" : ""}${top.rate.toFixed(1)}%)입니다.`;
    } else if (diff < -0.05) {
      v.className = "verdict";
      v.innerHTML = `당신의 물가는 공식 통계보다 <b>${Math.abs(diff).toFixed(1)}%p 낮습니다.</b>
        물가가 덜 오른 품목에 지출이 몰려 있습니다.`;
    } else {
      v.className = "verdict";
      v.innerHTML = `당신의 지출 구성은 전국 평균과 비슷해서, 체감 물가도 공식 통계와 거의 같습니다.`;
    }

    const sp = state.cpi.spread;
    if (sp) {
      $("#spreadNote").innerHTML =
        `같은 달인데도 <b>${sp.high.name} +${sp.high.yoy.toFixed(1)}%</b>,
         <b>${sp.low.name} +${sp.low.yoy.toFixed(1)}%</b>로 ${sp.gap.toFixed(1)}%p 벌어져 있습니다.
         "물가 ${official.toFixed(1)}%"는 아무의 물가도 아닙니다.`;
    }

    // 기여도 분해
    // 품목이 전체 평균보다 빨리 오르는지는 막대 색(오렌지/그린)만으로 표시했었다.
    // 색약 사용자를 위해 방향 기호(▲/▼)도 라벨에 같이 붙인다.
    Charts.contributionChart($("#contribChart"),
      sorted.filter((c) => c.amount > 0).map((c) => ({
        ...c, hot: c.rate >= official, color: c.rate >= official ? "var(--series-2)" : "var(--series-3)",
      })));
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
      status.textContent = "Gemini 해설 · 계산은 샐러리갭 엔진이 수행했습니다.";
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
      const data = await response.json();
      if (!response.ok || typeof data.text !== "string") throw new Error("AI 응답 오류");
      state.aiCache.set(cacheKey, data.text);
      body.textContent = data.text;
      status.textContent = "Gemini 해설 · 계산은 샐러리갭 엔진이 수행했습니다.";
    } catch (_error) {
      status.textContent = "AI 연결이 늦어 검증된 기본 해설을 보여드립니다.";
      $("#aiRetryBtn").hidden = false;
    } finally {
      clearTimeout(timeout);
      body.classList.remove("is-loading");
    }
  }

  /* ══════════════ 공유 카드 ══════════════
     MBTI류 사이트의 "당신은?" 결과 카드를 캔버스로 직접 그린다.
     외부 이미지 라이브러리 없이 <canvas>만으로 그리고, PNG로 내보낸다. */
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function buildShareCard() {
    const rate = state.personalRate;
    const official = state.cpi && state.cpi.latest ? state.cpi.latest.yoy : null;
    if (rate == null || official == null) return null;
    const diff = rate - official;
    const topCategory = state.aiContext ? state.aiContext.topCategory : null;

    const isDark = document.documentElement.getAttribute("data-theme") === "dark" ||
      (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const bg = isDark ? "#141412" : "#f7f7f4";
    const bg2 = isDark ? "#1c2620" : "#e6f0ea";
    const ink = isDark ? "#f5f5f2" : "#141412";
    const sub = isDark ? "#b7b6ae" : "#63625c";
    const brand = isDark ? "#4fae8b" : "#24745a";
    const track = isDark ? "#33322d" : "#e3e2db";
    const accent = diff > 0 ? "#b76442" : "#1f7a4d";
    const FONT = "-apple-system, 'Apple SD Gothic Neo', sans-serif";

    const SIZE = 1080;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");

    const grad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    grad.addColorStop(0, bg);
    grad.addColorStop(1, bg2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // 브랜드 마크
    ctx.fillStyle = brand;
    roundRectPath(ctx, 80, 84, 76, 76, 20);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `800 42px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("₩", 118, 126);

    ctx.fillStyle = ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = `800 40px ${FONT}`;
    ctx.fillText("샐러리갭", 176, 138);

    ctx.fillStyle = sub;
    ctx.font = `600 30px ${FONT}`;
    ctx.fillText("나의 연봉 성적표", 80, 260);

    ctx.fillStyle = ink;
    ctx.font = `800 164px ${FONT}`;
    ctx.fillText(`${rate.toFixed(1)}%`, 76, 470);

    ctx.fillStyle = sub;
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText("내 체감 물가", 80, 530);

    ctx.fillStyle = accent;
    ctx.font = `700 38px ${FONT}`;
    const verdict = Math.abs(diff) < 0.05
      ? "공식 물가와 거의 같아요"
      : `공식 물가보다 ${Math.abs(diff).toFixed(1)}%p ${diff > 0 ? "높아요" : "낮아요"}`;
    ctx.fillText(verdict, 80, 590);

    const barX = 80, barW = 920;
    const maxVal = Math.max(rate, official, 0.1) * 1.25;
    function bar(y, label, value, color) {
      ctx.fillStyle = sub;
      ctx.font = `600 26px ${FONT}`;
      ctx.fillText(label, barX, y - 14);
      ctx.fillStyle = track;
      roundRectPath(ctx, barX, y, barW, 22, 11);
      ctx.fill();
      ctx.fillStyle = color;
      const w = Math.max(14, (Math.max(value, 0) / maxVal) * barW);
      roundRectPath(ctx, barX, y, w, 22, 11);
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.font = `700 26px ${FONT}`;
      ctx.fillText(`${value.toFixed(1)}%`, barX + w + 16, y + 18);
    }
    bar(700, "공식 물가", official, isDark ? "#6b6a63" : "#c3c2b7");
    bar(772, "내 물가", rate, brand);

    if (topCategory) {
      ctx.fillStyle = sub;
      ctx.font = `500 28px ${FONT}`;
      ctx.fillText(`가장 크게 영향을 준 항목 · ${topCategory}`, 80, 862);
    }

    ctx.strokeStyle = track;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(80, 920);
    ctx.lineTo(1000, 920);
    ctx.stroke();

    ctx.fillStyle = brand;
    ctx.font = `700 34px ${FONT}`;
    ctx.fillText("당신의 체감 물가는 몇 %인가요?", 80, 975);
    ctx.fillStyle = sub;
    ctx.font = `500 26px ${FONT}`;
    ctx.fillText(location.host || "salarygap", 80, 1015);

    return canvas;
  }

  function setupShareCard() {
    const btn = $("#shareCardBtn");
    if (!btn) return;
    const dialog = $("#shareDialog");
    const img = $("#shareCardImg");
    const downloadBtn = $("#shareDownloadBtn");
    const nativeBtn = $("#shareNativeBtn");

    btn.addEventListener("click", () => {
      const canvas = buildShareCard();
      if (!canvas) return;
      const dataUrl = canvas.toDataURL("image/png");
      img.src = dataUrl;
      downloadBtn.href = dataUrl;

      nativeBtn.hidden = true;
      canvas.toBlob((blob) => {
        if (!blob) return;
        const file = new File([blob], "salarygap-card.png", { type: "image/png" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          nativeBtn.hidden = false;
          nativeBtn.onclick = () => {
            navigator.share({
              files: [file],
              title: "내 연봉 성적표",
              text: "내 체감 물가를 확인해봤어요 — 샐러리갭",
            }).catch(() => {});
          };
        }
      });

      if (!dialog.open) dialog.showModal();
    });

    $("#shareCloseBtn").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
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
    const plans = Object.keys(state.market.portfolios).map((k) => E.planOf(state.market, k));
    const enough = plans.filter((p) => p.expected_return * 100 >= rate);
    const minPlan = enough.length ? enough[0] : null;

    $("#mineActionStats").innerHTML = `
      <div class="stat"><span class="k">최소 연봉 인상률</span><span class="v">${rate.toFixed(1)}%</span>
        <span class="s">이만큼 올려야 본전</span></div>
      <div class="stat"><span class="k">필요 투자 수익률</span><span class="v">${rate.toFixed(1)}%</span>
        <span class="s">굴려서 방어하려면</span></div>
      <div class="stat ${hl && hl < 20 ? "is-warn" : ""}"><span class="k">구매력 반감기</span>
        <span class="v">${hl ? `${hl.toFixed(1)}년` : "—"}</span>
        <span class="s">지금 돈의 가치가 절반 되는 시점</span></div>
      <div class="stat ${minPlan ? "is-good" : "is-bad"}"><span class="k">방어 가능한 최소 포트폴리오</span>
        <span class="v">${minPlan ? minPlan.label : "없음"}</span>
        <span class="s">${minPlan ? `기대 ${pct(minPlan.expected_return)}` : "적극형으로도 부족"}</span></div>`;

    const a = $("#mineAction");
    if (minPlan) {
      a.className = "verdict";
      a.innerHTML = `내 물가 <b>${rate.toFixed(1)}%</b>를 넘기려면 연봉을 그만큼 올려받거나,
        <b>${minPlan.label}</b> 이상으로 굴려야 합니다(실제 10년 실현 기준 ${pct(minPlan.expected_return)}).
        아무것도 안 하면 지금 돈의 가치는 <b>${hl.toFixed(1)}년 뒤 절반</b>이 됩니다.`;
    } else {
      a.className = "verdict bad";
      a.innerHTML = `내 물가 <b>${rate.toFixed(1)}%</b>는 적극형 포트폴리오의 기대수익률로도 방어가 어렵습니다.
        지출 구조를 바꾸거나 소득을 늘리는 쪽을 함께 봐야 합니다.`;
    }
  }

  /* ══════════════ 탭 1 · 실질임금 진단 ══════════════ */
  function setupGapTab() {
    ["#curSalary", "#nextSalary", "#budget", "#inflation"].forEach((sel) => {
      $(sel).addEventListener("input", () => {
        if (sel === "#inflation") {
          state.inflation = parseFloat($("#inflation").value);
          state.inflationLive = false;
          $("#inflSource").textContent = "직접 조정한 값으로 계산 중입니다.";
        }
        // "월 투자 가능액"과 목표 자산 탭의 "월 저축 가능액"은 같은 돈이다.
        // 탭을 옮길 때마다 다시 입력하지 않도록 값을 그대로 맞춰준다.
        if (sel === "#budget") {
          $("#goalMonthly").value = $("#budget").value;
          renderGoal();
        }
        renderGap();
      });
    });
    $$("#riskSeg button").forEach((b) => {
      b.addEventListener("click", () => {
        state.risk = b.dataset.risk;
        state.goalRisk = b.dataset.risk;
        $$("#riskSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        $$("#goalRiskSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.risk === b.dataset.risk)));
        renderGap();
        renderGoal();
      });
    });
  }

  function readGapInputs() {
    const cur = Math.max(0, +$("#curSalary").value || 0);
    const next = Math.max(0, +$("#nextSalary").value || 0);
    const budget = Math.max(0, +$("#budget").value || 0);
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
    return { cur, next, budget, valid: cur > 0 };
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
    const { cur, next, budget, valid } = readGapInputs();
    $("#inflVal").textContent = `${state.inflation.toFixed(1)}%`;
    $("#budgetVal").textContent = `${man(budget)}만원`;
    if (!valid) return;

    const d = E.diagnose({ curSalary: cur, nextSalary: next, inflationPct: state.inflation });

    // 투자로 만드는 연 수익. 슬라이더 바로 아래 KPI와 결론 문장에 함께 쓴다.
    // (이 값이 화면 위쪽에 없으면 슬라이더를 움직여도 반응이 없어 보인다)
    const plan = E.planOf(state.market, state.risk);
    const annualGain = plan ? budget * 12 * plan.expected_return : 0;

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
      <div class="stat"><span class="k">내년 연봉의 체감 가치</span>
        <span class="v">${man(d.realValue)}만원</span>
        <span class="s">올해 물가 기준</span></div>
      ${workdayStat(next, d)}
      <div class="stat ${annualGain > 0 ? "is-good" : ""}"><span class="k">투자로 만드는 연 수익</span>
        <span class="v">${man(annualGain)}만원</span>
        <span class="s">월 ${man(budget)}만원 · ${plan ? plan.label : ""} ${plan ? pct(plan.expected_return) : ""}</span></div>`;

    // 조작하면 같이 바뀌는 결론.
    // 부족분은 "매년 되풀이되는 소득 손실"이므로, 이를 메우는 것도 매년 들어오는
    // 투자 '수익'이어야 한다. 투자 원금(budget×12)과 비교하면 안 된다 —
    // 원금은 소득에서 저축으로 옮긴 것일 뿐 새로 생긴 돈이 아니다.
    const v = $("#gapVerdict");
    if (d.beatsInflation) {
      v.className = "verdict";
      v.innerHTML = `내년 연봉 <b>${man(next)}만원</b>은 물가 유지선(${man(d.requiredSalary)}만원)을
        <b>${man(-d.gap)}만원 넘어섭니다.</b> 실질 소득이 늘어나는 구간입니다.
        여기에 투자로 월 ${man(budget)}만원씩 더 굴리면 연 <b>${man(annualGain)}만원</b>이 추가로 쌓입니다.`;
    } else {
      const rate = d.gap > 0 ? Math.min(100, (annualGain / d.gap) * 100) : 100;
      const days = next > 0 ? d.gap / (next / WORKDAYS_PER_YEAR) : 0;
      const needMonthly = plan && plan.expected_return > 0
        ? d.gap / plan.expected_return / 12 : null;
      v.className = d.gap > cur * 0.03 ? "verdict bad" : "verdict warn";
      v.innerHTML = `물가를 따라가려면 <b>${man(d.requiredSalary)}만원</b>이 필요한데
        내년 연봉은 ${man(next)}만원입니다. 연 <b>${man(d.gap)}만원</b>(월 ${man(d.monthlyGap)}만원)이 부족합니다.
        <b>작년과 같은 생활을 하려면 ${days.toFixed(1)}일을 더 일해야 하는 셈입니다.</b>
        지금 설정한 월 ${man(budget)}만원 투자로 생기는 연 수익 ${man(annualGain)}만원은
        이 부족분의 <b>${rate.toFixed(0)}%</b>입니다.` +
        (needMonthly && rate < 100
          ? ` 전부 메우려면 월 <b>${man(Math.ceil(needMonthly))}만원</b>을 굴려야 합니다.`
          : "");
    }

    renderPlan(d, budget, plan, annualGain);
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
        매년 <b>${(state.inflation - d.nominalRatePct).toFixed(1)}%p</b>씩 밀리는 게 복리로 쌓인 결과입니다.`;
    }
  }

  function renderPlan(d, budget, plan, annualGain) {
    if (!plan) return;

    $("#riskNote").textContent = plan.desc;

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
        <span class="s">월 ${man(budget)}만원 투자 시</span></div>
      <div class="stat"><span class="k">예상 변동성</span><span class="v">${pct(plan.expected_volatility)}</span>
        <span class="s">연 표준편차</span></div>`;

    $("#planLegend").innerHTML = plan.items.map((it) =>
      `<span class="legend-item"><span class="legend-swatch" style="background:${colorOf(it.id)}"></span>
       ${it.asset ? it.asset.name : it.id} ${(it.weight * 100).toFixed(0)}%</span>`).join("");

    $("#planTable").innerHTML = plan.items.map((it) => {
      const a = it.asset;
      if (!a) return "";
      const mdd = a.mdd ? signPct(a.mdd.depth) : "—";
      const flag = a.assumed ? ` <span class="risk-badge risk-mid">가정값</span>` : "";
      return `<tr>
        <td><span class="legend-swatch" style="background:${colorOf(it.id)};display:inline-block;margin-right:.4rem"></span>${a.name}${flag}</td>
        <td class="num">${(it.weight * 100).toFixed(0)}%</td>
        <td class="num">${signPct(a.cagr)}</td>
        <td class="num">${a.volatility ? pct(a.volatility) : "—"}</td>
        <td class="num">${mdd}</td></tr>`;
    }).join("");

    const src = state.market.assets.find((a) => a.id === "kodex200");
    $("#planSrc").textContent =
      `실제 월말 종가 ${src ? src.range[0] : ""}~${src ? src.range[1] : ""} 기준 · 예금은 가정값 ${pct(state.market.cash_assumption, 1)}`;
  }

  function renderNegotiation(cur, d) {
    const n = E.negotiate({
      curSalary: cur, inflationPct: state.inflation,
      offeredRatePct: d.nominalRatePct, desiredRealRatePct: 1,
    });
    $("#negoStats").innerHTML = `
      <div class="stat"><span class="k">물가 방어 인상률</span><span class="v">${state.inflation.toFixed(1)}%</span>
        <span class="s">최소 기준선</span></div>
      <div class="stat"><span class="k">실질 +1% 목표</span><span class="v">${n.targetRatePct.toFixed(1)}%</span>
        <span class="s">목표 연봉 ${man(n.targetSalary)}만원</span></div>
      <div class="stat"><span class="k">제안받은 인상률</span><span class="v">${d.nominalRatePct.toFixed(1)}%</span>
        <span class="s">현재 입력값</span></div>
      <div class="stat ${n.shortfallPp <= 0 ? "is-good" : "is-warn"}"><span class="k">차이</span>
        <span class="v">${n.shortfallPp <= 0 ? "달성" : `${n.shortfallPp.toFixed(1)}%p`}</span>
        <span class="s">${n.shortfallPp <= 0 ? "목표 이상" : `${man(n.shortfallAmount)}만원 부족`}</span></div>`;

    const v = $("#negoVerdict");
    if (n.shortfallPp <= 0) {
      v.className = "verdict";
      v.innerHTML = `제안받은 <b>${d.nominalRatePct.toFixed(1)}%</b>는 물가에 실질 +1%를 더한 목표선을 이미 넘었습니다.`;
    } else {
      v.className = "verdict warn";
      v.innerHTML = `협상 테이블에서 말할 숫자는 <b>${n.targetRatePct.toFixed(1)}%</b>입니다.
        물가 ${state.inflation.toFixed(1)}%에 실질 인상 1%를 더한 값이고, 연봉으로는
        <b>${man(n.targetSalary)}만원</b>입니다. 현재 제안과는 ${n.shortfallPp.toFixed(1)}%p 차이입니다.`;
    }
  }

  /* ══════════════ 탭 2 · 목표 자산 ══════════════ */
  function setupGoalTab() {
    ["#goalAmount", "#goalYears", "#goalCurrent", "#goalMonthly"].forEach((sel) =>
      $(sel).addEventListener("input", () => {
        // 실질임금 진단의 "월 투자 가능액"과 같은 돈이다 — 여기서 바꿔도 맞춰준다.
        if (sel === "#goalMonthly") {
          $("#budget").value = $("#goalMonthly").value;
          renderGap();
        }
        renderGoal();
      }));
    $$("#goalRiskSeg button").forEach((b) => {
      b.addEventListener("click", () => {
        state.goalRisk = b.dataset.risk;
        state.risk = b.dataset.risk;
        $$("#goalRiskSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        $$("#riskSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.risk === b.dataset.risk)));
        renderGoal();
        renderGap();
      });
    });
  }

  function renderGoal() {
    const goal = Math.max(0, +$("#goalAmount").value || 0);
    const years = Math.max(1, Math.min(40, +$("#goalYears").value || 1));
    const current = Math.max(0, +$("#goalCurrent").value || 0);
    const monthly = Math.max(0, +$("#goalMonthly").value || 0);
    const months = years * 12;

    const err = $("#goalErr");
    if (goal <= current) {
      err.textContent = "목표 금액이 현재 보유 자산보다 크지 않습니다.";
      err.hidden = false;
    } else { err.hidden = true; }

    const plan = E.planOf(state.market, state.goalRisk);
    if (!plan) return;
    $("#goalRiskNote").textContent =
      `${plan.desc} 기대수익률 ${pct(plan.expected_return)} (실제 시장 데이터 기준)`;

    // 필요 저축액은 올림한다. 내림하면 "100만원이면 된다"고 해놓고
    // 정작 100만원으로는 목표에 못 닿는 모순이 생긴다.
    const need = Math.ceil(
      E.requiredMonthly({ goal, current, months, annualReturn: plan.expected_return })
    );
    const path = E.project({ initial: current, monthly, months, annualReturn: plan.expected_return });
    const projected = path[path.length - 1].value;
    const diff = projected - goal;

    $("#goalStats").innerHTML = `
      <div class="stat"><span class="k">필요 월 저축액</span><span class="v">${man(need)}만원</span>
        <span class="s">${plan.label} 기준</span></div>
      <div class="stat"><span class="k">현재 계획의 예상 자산</span><span class="v">${man(projected)}만원</span>
        <span class="s">${years}년 후</span></div>
      <div class="stat ${diff >= 0 ? "is-good" : "is-bad"}"><span class="k">${diff >= 0 ? "여유" : "부족"}</span>
        <span class="v">${man(Math.abs(diff))}만원</span>
        <span class="s">목표 ${man(goal)}만원 대비</span></div>
      <div class="stat"><span class="k">원금 대비 수익</span>
        <span class="v">${man(projected - current - monthly * months)}만원</span>
        <span class="s">복리 효과</span></div>`;

    const v = $("#goalVerdict");
    if (diff >= 0) {
      v.className = "verdict";
      v.innerHTML = `월 <b>${man(monthly)}만원</b>이면 ${years}년 뒤 <b>${man(projected)}만원</b>으로
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
    for (let y = 0; y <= years; y += Math.max(1, Math.round(years / 5))) {
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
    const assets = state.market.assets.filter((a) => !a.assumed);
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

    $("#startFuturePlan").addEventListener("click", () => {
      const amount = Math.max(0, +$("#investAmount").value || 0);
      if (amount <= 0) {
        $("#investAmount").focus();
        return;
      }
      $("#goalCurrent").value = amount;
      renderGoal();
      $("#tab-goal").click();
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
      `데이터 갱신 ${gen.toLocaleString("ko-KR")} · 시세 스냅샷은 GitHub Actions가 매일 자동 수집합니다.`;
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
