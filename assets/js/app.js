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
  const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;
  const signPct = (n, d = 1) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;

  const ASSET_COLOR = {
    cash: "var(--series-1)", bond10y: "var(--series-3)", kodex200: "var(--series-2)",
    sp500: "var(--series-4)", gold: "var(--series-5)", bitcoin: "var(--series-6)",
  };
  const colorOf = (id) => ASSET_COLOR[id] || "var(--text-muted)";

  // 프리셋은 통계가 아니라 예시 페르소나다. 화면에도 그렇게 밝힌다.
  // 숫자는 월 지출액(만원).
  // 가구 규모가 아니라 라이프스타일로 나눴다. 물가 체감의 차이를 만드는 건
  // 식구 수가 아니라 "돈을 어디에 쓰느냐"이기 때문이다.
  const PRESETS = {
    car: {
      label: "차로 출퇴근",
      spending: { food: 22, alcohol: 6, clothing: 12, housing: 55, household: 5,
                  health: 5, transport: 55, comm: 8, leisure: 25, education: 0,
                  dining: 45, misc: 12 },
    },
    dining: {
      label: "외식·구독 많은 1인",
      spending: { food: 12, alcohol: 8, clothing: 14, housing: 58, household: 4,
                  health: 4, transport: 12, comm: 8, leisure: 38, education: 0,
                  dining: 60, misc: 14 },
    },
    home: {
      label: "집밥·대중교통",
      spending: { food: 48, alcohol: 4, clothing: 6, housing: 52, household: 5,
                  health: 7, transport: 8, comm: 7, leisure: 6, education: 0,
                  dining: 14, misc: 7 },
    },
  };

  const state = {
    market: null, cpi: null, meta: null,
    risk: "balanced", goalRisk: "balanced",
    inflation: 2.8, inflationLive: false,
    picks: new Set(["kodex200", "sp500", "gold"]),
    startMonth: null,
    spending: { ...PRESETS.car.spending },
    preset: "car",
    personalRate: null,
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

  /* ══════════════ 탭 0 · 내 물가 ══════════════ */
  function setupMineTab() {
    const cats = state.cpi.categories || [];
    if (!cats.length) {
      $("#panel-mine").innerHTML =
        `<div class="load-error">품목별 물가 데이터가 없습니다. 파이프라인을 다시 실행해 주세요.</div>`;
      return;
    }

    // 지출 입력 행 — 품목별 현재 물가를 칩으로 같이 보여준다.
    // 어떤 항목이 비싸지고 있는지 입력하면서 바로 알 수 있게.
    // 12개를 한 번에 늘어놓으면 입력 벽처럼 보여서, 지출 비중이 큰
    // 6개만 펼치고 나머지는 접어 둔다.
    const PRIMARY = ["housing", "food", "dining", "transport", "leisure", "comm"];
    const row = (c) => {
      const r = c.latest.yoy;
      const cls = r >= 4 ? "rate-hot" : (r <= 1 ? "rate-cool" : "rate-mild");
      return `<div class="spend-row">
        <label for="sp-${c.id}">${c.name}
          <span class="rate-chip ${cls}">${r >= 0 ? "+" : ""}${r.toFixed(1)}%</span>
          <small>${c.hint}</small>
        </label>
        <span class="input-wrap">
          <input type="number" id="sp-${c.id}" min="0" step="1" value="${state.spending[c.id] ?? 0}">
          <span>만원</span>
        </span>
      </div>`;
    };

    const primary = cats.filter((c) => PRIMARY.includes(c.id));
    const secondary = cats.filter((c) => !PRIMARY.includes(c.id));
    $("#spendFields").innerHTML = primary.map(row).join("");
    $("#spendFieldsMore").innerHTML = secondary.map(row).join("");
    $("#moreCount").textContent = `(${secondary.length}개)`;

    cats.forEach((c) => {
      $(`#sp-${c.id}`).addEventListener("input", (e) => {
        state.spending[c.id] = Math.max(0, +e.target.value || 0);
        $$("#presetSeg button").forEach((b) => b.setAttribute("aria-pressed", "false"));
        state.preset = null;
        renderMine();
      });
    });

    $$("#presetSeg button").forEach((b) => {
      b.addEventListener("click", () => {
        const p = PRESETS[b.dataset.preset];
        if (!p) return;
        state.preset = b.dataset.preset;
        state.spending = { ...p.spending };
        $$("#presetSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        cats.forEach((c) => { $(`#sp-${c.id}`).value = state.spending[c.id] ?? 0; });
        renderMine();
      });
    });

    $("#applyToSalary").addEventListener("click", () => {
      if (state.personalRate == null) return;
      state.inflation = state.personalRate;
      state.inflationLive = false;
      $("#inflation").value = state.personalRate.toFixed(1);
      $("#inflSource").innerHTML =
        `<b>내 물가 ${state.personalRate.toFixed(1)}%</b>를 적용했습니다. ` +
        `공식 물가(${state.cpi.latest.yoy.toFixed(1)}%) 대신 내 지출 기준으로 진단합니다.`;
      $("#tab-gap").click();
      $("#panel-gap").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function renderMine() {
    const cats = state.cpi.categories || [];
    if (!cats.length) return;

    const result = E.personalInflation(state.spending, cats);
    const official = state.cpi.latest.yoy;

    if (!result) {
      $("#personalRate").textContent = "—";
      $("#mineVerdict").textContent = "지출을 하나 이상 입력해 주세요.";
      $("#spendTotal").textContent = "0만원";
      return;
    }

    state.personalRate = result.rate;
    const diff = result.rate - official;

    $("#officialRate").textContent = `${official.toFixed(1)}%`;
    $("#officialMonth").textContent = `${state.cpi.latest.month} 기준`;
    $("#personalRate").textContent = `${result.rate.toFixed(1)}%`;
    $("#spendTotal").textContent = `${man(result.total)}만원`;

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
    Charts.contributionChart($("#contribChart"),
      sorted.filter((c) => c.amount > 0).map((c) => ({
        ...c, color: c.rate >= official ? "var(--series-2)" : "var(--series-3)",
      })));
    $("#mineSrc").textContent =
      `OECD 한국 소비자물가 COICOP 12분류 · ${result.month} 기준 · 브라우저에서 실시간 조회`;

    renderCumulative(result);
    renderMineAction(result, official);
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
      ${workdayStat(next, d)}`;

    // 조작하면 같이 바뀌는 결론
    const v = $("#gapVerdict");
    if (d.beatsInflation) {
      v.className = "verdict";
      v.innerHTML = `내년 연봉 <b>${man(next)}만원</b>은 물가 유지선(${man(d.requiredSalary)}만원)을
        <b>${man(-d.gap)}만원 넘어섭니다.</b> 실질 소득이 늘어나는 구간입니다.`;
    } else {
      const covered = budget * 12;
      const rate = d.gap > 0 ? Math.min(100, (covered / d.gap) * 100) : 100;
      const days = next > 0 ? d.gap / (next / WORKDAYS_PER_YEAR) : 0;
      v.className = d.gap > cur * 0.03 ? "verdict bad" : "verdict warn";
      v.innerHTML = `물가를 따라가려면 <b>${man(d.requiredSalary)}만원</b>이 필요한데
        내년 연봉은 ${man(next)}만원입니다. 연 <b>${man(d.gap)}만원</b>(월 ${man(d.monthlyGap)}만원)이 부족합니다.
        <b>작년과 같은 생활을 하려면 ${days.toFixed(1)}일을 더 일해야 하는 셈입니다.</b>
        지금 설정한 월 ${man(budget)}만원 투자로는 이 부족분의 <b>${rate.toFixed(0)}%</b>를 메울 수 있습니다.`;
    }

    renderPlan(d, budget);
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
    renderMine();
    renderGap();
    renderGoal();
    renderTime();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
