/* ============================================================
   화면 조립 — 데이터 로드, 입력 바인딩, 렌더링
   ============================================================ */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const { barChart, hBarChart, lineChart } = window.Charts;
  const E = window.Engine;

  const man = (n) => Math.round(n).toLocaleString("ko-KR");
  const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;
  const signPct = (n, d = 1) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;

  const ASSET_COLOR = {
    cash: "var(--series-1)", bond10y: "var(--series-3)", kodex200: "var(--series-2)",
    sp500: "var(--series-4)", gold: "var(--series-5)", bitcoin: "var(--series-6)",
  };
  const colorOf = (id) => ASSET_COLOR[id] || "var(--text-muted)";

  const state = {
    market: null, cpi: null, meta: null,
    risk: "balanced", goalRisk: "balanced",
    inflation: 2.8, inflationLive: false,
    picks: new Set(["kodex200", "sp500", "gold"]),
    startMonth: null,
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
    setupGapTab();
    setupGoalTab();
    setupTimeTab();
    renderBasis();
    renderAll();

    // 실시간은 화면이 다 그려진 뒤에 붙인다 (실패해도 화면은 이미 완성)
    hydrateLive();
  }

  /* ══════════════ 실시간 ══════════════ */
  async function hydrateLive() {
    const res = await window.Live.fetchAll();
    renderTicker(res);

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

    if (res.btc.ok) {
      const d = res.btc.data;
      const dir = d.delta == null ? "" :
        `<span class="delta ${d.delta >= 0 ? "up" : "down"}">${d.delta >= 0 ? "▲" : "▼"}${Math.abs(d.delta).toFixed(2)}%</span>`;
      items.push(`<span class="tick"><span class="live-dot"></span><span class="lbl">비트코인</span>
        <b>${man(d.value / 10000)}만원</b>${dir}</span>`);
    }

    const snap = new Date(state.market.source_fetched_at);
    items.push(`<span class="tick"><span class="live-dot stale"></span><span class="lbl">시세 스냅샷</span>
      <b>${snap.getFullYear()}.${String(snap.getMonth() + 1).padStart(2, "0")}.${String(snap.getDate()).padStart(2, "0")}</b>
      <span class="lbl">매일 자동 갱신</span></span>`);

    $("#ticker").innerHTML = items.join("");
  }

  /* ══════════════ 탭 ══════════════ */
  function setupTabs() {
    const tabs = $$(".tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => {
          const on = t === tab;
          t.setAttribute("aria-selected", String(on));
          $("#" + t.getAttribute("aria-controls")).hidden = !on;
        });
        renderAll();
      });
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

  /* ══════════════ 탭 1 · 실질임금 진단 ══════════════ */
  function setupGapTab() {
    ["#curSalary", "#nextSalary", "#budget", "#inflation"].forEach((sel) => {
      $(sel).addEventListener("input", () => {
        if (sel === "#inflation") {
          state.inflation = parseFloat($("#inflation").value);
          state.inflationLive = false;
          $("#inflSource").textContent = "직접 조정한 값으로 계산 중입니다.";
        }
        renderGap();
      });
    });
    $$("#riskSeg button").forEach((b) => {
      b.addEventListener("click", () => {
        state.risk = b.dataset.risk;
        $$("#riskSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        renderGap();
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

  function renderGap() {
    const { cur, next, budget, valid } = readGapInputs();
    $("#inflVal").textContent = `${state.inflation.toFixed(1)}%`;
    $("#budgetVal").textContent = `${man(budget)}만원`;
    if (!valid) return;

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
      <div class="stat"><span class="k">내년 연봉의 체감 가치</span>
        <span class="v">${man(d.realValue)}만원</span>
        <span class="s">올해 물가 기준</span></div>`;

    // 조작하면 같이 바뀌는 결론
    const v = $("#gapVerdict");
    if (d.beatsInflation) {
      v.className = "verdict";
      v.innerHTML = `내년 연봉 <b>${man(next)}만원</b>은 물가 유지선(${man(d.requiredSalary)}만원)을
        <b>${man(-d.gap)}만원 넘어섭니다.</b> 실질 소득이 늘어나는 구간입니다.`;
    } else {
      const covered = budget * 12;
      const rate = d.gap > 0 ? Math.min(100, (covered / d.gap) * 100) : 100;
      v.className = d.gap > cur * 0.03 ? "verdict bad" : "verdict warn";
      v.innerHTML = `물가를 따라가려면 <b>${man(d.requiredSalary)}만원</b>이 필요한데
        내년 연봉은 ${man(next)}만원입니다. 연 <b>${man(d.gap)}만원</b>(월 ${man(d.monthlyGap)}만원)이 부족합니다.
        지금 설정한 월 ${man(budget)}만원 투자로는 이 부족분의 <b>${rate.toFixed(0)}%</b>를 메울 수 있습니다.`;
    }

    renderPlan(d, budget);
    renderNegotiation(cur, d);
  }

  function renderPlan(d, budget) {
    const plan = E.planOf(state.market, state.risk);
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
    const annualGain = budget * 12 * plan.expected_return;
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
      $(sel).addEventListener("input", renderGoal));
    $$("#goalRiskSeg button").forEach((b) => {
      b.addEventListener("click", () => {
        state.goalRisk = b.dataset.risk;
        $$("#goalRiskSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        renderGoal();
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
      return;
    }

    const results = picked.map((a) => ({ asset: a, bt: E.backtest(a, start, amount) }))
      .filter((r) => r.bt);
    if (!results.length) {
      $("#timeChart").innerHTML = `<p class="skeleton">선택한 기간에 데이터가 없습니다.</p>`;
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
      선택한 ${results.length}개 중 <b>${beat.length}개</b>가 같은 기간 물가상승을 이겼습니다.`;

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
  }

  /* ══════════════ 계산 근거 ══════════════ */
  function renderBasis() {
    $("#srcList").innerHTML = state.meta.sources.map((s) =>
      `<li><strong>${s.name}</strong> — ${s.use}
       ${s.live_in_browser
        ? '<span class="risk-badge risk-low">브라우저에서 실시간 조회</span>'
        : `<span class="risk-badge risk-mid">일 1회 스냅샷</span> <span style="color:var(--text-muted)">${s.reason || ""}</span>`}
       </li>`).join("");

    const clean = state.meta.notes || [];
    $("#cleanList").innerHTML = clean.length
      ? clean.map((n) => `<li>${n}</li>`).join("")
      : `<li>이번 수집분에서 제외된 값은 없습니다.</li>`;

    $("#assumeList").innerHTML = state.meta.assumptions.map((a) => `<li>${a}</li>`).join("");

    const gen = new Date(state.meta.generated_at);
    $("#buildInfo").textContent =
      `데이터 갱신 ${gen.toLocaleString("ko-KR")} · 시세 스냅샷은 GitHub Actions가 매일 자동 수집합니다.`;
  }

  /* ══════════════ 전체 렌더 ══════════════ */
  function renderAll() {
    if (!state.market) return;
    renderGap();
    renderGoal();
    renderTime();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
