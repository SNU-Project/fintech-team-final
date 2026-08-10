/* ============================================================
   계산 엔진
   SOMIN의 계산 구조를 이어받되, 기대수익률은 하드코딩하지 않고
   pipeline이 만든 실제 시장 데이터(market.json)에서 가져온다.
   ============================================================ */
(function (global) {
  "use strict";

  /* ---------- 1. 실질임금 진단 ---------- */
  // 물가가 오른 만큼 연봉도 올라야 작년과 같은 생활수준이 유지된다.
  function diagnose({ curSalary, nextSalary, inflationPct }) {
    const infl = inflationPct / 100;
    const requiredSalary = curSalary * (1 + infl);   // 실질 유지에 필요한 연봉
    const nominalRaise = nextSalary - curSalary;      // 명목 인상액
    const nominalRatePct = curSalary > 0 ? (nominalRaise / curSalary) * 100 : 0;
    const gap = requiredSalary - nextSalary;          // +면 부족, -면 여유
    const realRatePct = nominalRatePct - inflationPct;
    // 내년 연봉을 올해 물가로 할인한 값 = 체감 가치
    const realValue = nextSalary / (1 + infl);

    return {
      requiredSalary, nominalRaise, nominalRatePct,
      gap, monthlyGap: gap / 12, realRatePct, realValue,
      beatsInflation: gap <= 0,
    };
  }

  /* ---------- 2. 연봉 협상 ---------- */
  function negotiate({ curSalary, inflationPct, offeredRatePct, desiredRealRatePct = 0 }) {
    const targetRatePct = inflationPct + desiredRealRatePct;
    const targetSalary = curSalary * (1 + targetRatePct / 100);
    const shortfallPp = targetRatePct - offeredRatePct;
    return {
      targetRatePct, targetSalary, shortfallPp,
      shortfallAmount: targetSalary - curSalary * (1 + offeredRatePct / 100),
    };
  }

  /* ---------- 3. 자산 성장 시뮬레이션 ---------- */
  // 매월 초 적립 후 월 복리. 연 수익률을 월 환산할 때 (1+r)^(1/12)를 쓴다.
  function project({ initial, monthly, months, annualReturn }) {
    const m = Math.pow(1 + annualReturn, 1 / 12) - 1;
    const path = [];
    let value = initial;
    for (let i = 0; i <= months; i++) {
      if (i > 0) value = (value + monthly) * (1 + m);
      path.push({ month: i, value });
    }
    return path;
  }

  // 목표 금액에 닿기 위해 매월 얼마가 필요한지 역산
  function requiredMonthly({ goal, current, months, annualReturn }) {
    if (months <= 0) return Math.max(0, goal - current);
    const m = Math.pow(1 + annualReturn, 1 / 12) - 1;
    const grownCurrent = current * Math.pow(1 + m, months);
    const remaining = goal - grownCurrent;
    if (remaining <= 0) return 0;
    // 기말 적립 연금의 미래가치 계수
    const factor = m === 0 ? months : ((Math.pow(1 + m, months) - 1) / m) * (1 + m);
    return remaining / factor;
  }

  // 지금 페이스(월 적립액 고정)로 목표 금액에 실제로 몇 개월 뒤 도달하는지.
  // requiredMonthly는 "기간을 고정하고 필요한 월 적립액"을 구하는 반대
  // 방향 계산이라 이 용도로 못 쓴다 — project()를 목표 기간보다 긴
  // 구간(기본 50년)까지 돌려서 목표를 넘어서는 첫 달을 찾는다.
  function monthsToGoal({ initial, monthly, goal, annualReturn, maxMonths = 600 }) {
    if (initial >= goal) return 0;
    const path = project({ initial, monthly, months: maxMonths, annualReturn });
    const hit = path.find((p) => p.value >= goal);
    return hit ? hit.month : null; // null = maxMonths 안에 못 닿음
  }

  /* ---------- 4. 백테스트 (자산 타임머신) ---------- */
  // 실제 월말 종가 인덱스를 그대로 사용한다. 곡선을 만들어내지 않는다.
  function backtest(asset, startMonth, amount) {
    if (!asset || !Number.isFinite(amount) || amount <= 0) return null;
    const idx = asset.index || {};
    const months = Object.keys(idx).sort().filter((m) => m >= startMonth);
    if (months.length < 2) return null;

    const base = idx[months[0]];
    if (!base) return null;

    const path = months.map((m) => ({
      month: m,
      value: (idx[m] / base) * amount,
    }));

    const finalValue = path[path.length - 1].value;
    const years = (months.length - 1) / 12;
    const totalReturn = finalValue / amount - 1;
    const cagr = years > 0 ? Math.pow(finalValue / amount, 1 / years) - 1 : 0;

    // 이 구간만의 최대 낙폭
    let peak = -Infinity, mdd = 0;
    for (const p of path) {
      if (p.value > peak) peak = p.value;
      else if (peak > 0) mdd = Math.min(mdd, p.value / peak - 1);
    }

    return { path, finalValue, totalReturn, cagr, mdd, months, years };
  }

  // 특정 시작 달 하나의 우연을 결과로 오해하지 않도록 앞뒤 달의 실제 결과도
  // 함께 계산한다. 결측 월은 보간하지 않고, 실제 관측치가 있는 달만 쓴다.
  function backtestWindow(asset, startMonth, amount, radius = 6) {
    const byObservedMonth = new Map();
    for (let offset = -radius; offset <= radius; offset++) {
      const requested = addMonths(startMonth, offset);
      const bt = backtest(asset, requested, amount);
      if (!bt) continue;
      const observed = bt.months[0];
      if (!byObservedMonth.has(observed)) {
        byObservedMonth.set(observed, {
          startMonth: observed,
          finalValue: bt.finalValue,
          totalReturn: bt.totalReturn,
        });
      }
    }

    const samples = Array.from(byObservedMonth.values())
      .sort((a, b) => a.finalValue - b.finalValue);
    if (samples.length < 2) return null;

    const mid = Math.floor(samples.length / 2);
    const median = samples.length % 2
      ? samples[mid].finalValue
      : (samples[mid - 1].finalValue + samples[mid].finalValue) / 2;
    const selected = backtest(asset, startMonth, amount);

    return {
      samples,
      count: samples.length,
      min: samples[0].finalValue,
      max: samples[samples.length - 1].finalValue,
      median,
      selected: selected ? selected.finalValue : null,
    };
  }

  // 소비자물가지수도 같은 방식으로 환산해 "물가선"을 만든다.
  function inflationPath(cpiIndex, startMonth, amount) {
    const months = Object.keys(cpiIndex).sort().filter((m) => m >= startMonth);
    if (months.length < 2) return null;
    const base = cpiIndex[months[0]];
    if (!base) return null;
    return {
      path: months.map((m) => ({ month: m, value: (cpiIndex[m] / base) * amount })),
      months,
    };
  }

  /* ---------- 5. 포트폴리오 ---------- */
  // 실제 자산 CAGR의 가중평균으로 계산된 값을 market.json에서 그대로 읽는다.
  function planOf(market, riskKey) {
    const plan = market.portfolios[riskKey];
    if (!plan) return null;
    const byId = Object.fromEntries(market.assets.map((a) => [a.id, a]));
    const items = Object.entries(plan.weights).map(([id, weight]) => ({
      id, weight, asset: byId[id],
    })).sort((a, b) => b.weight - a.weight);
    return { ...plan, key: riskKey, items };
  }

  /* ---------- 6. 내 물가 ----------
     공식 물가(2.8%)는 전국 평균 지출 비중으로 가중한 값이다.
     같은 달에도 교통은 +7.7%, 통신은 +0.7%라 사람마다 체감이 다르다.
     여기서는 사용자가 입력한 실제 지출액으로 가중치를 만들어
     "그 사람의 물가"를 계산한다.                                       */

  // spending: { categoryId: 월 지출액(만원) }
  function personalInflation(spending, categories) {
    const total = Object.values(spending).reduce((a, b) => a + (b || 0), 0);
    if (total <= 0) return null;

    const contributions = categories.map((cat) => {
      const amount = spending[cat.id] || 0;
      const weight = amount / total;
      const rate = cat.latest.yoy;
      return {
        id: cat.id, name: cat.name, hint: cat.hint,
        amount, weight, rate,
        contribution: weight * rate,   // %p 단위 기여도
      };
    });

    const rate = contributions.reduce((sum, c) => sum + c.contribution, 0);
    return { rate, total, contributions, month: categories[0].latest.month };
  }

  // personalInflation()이 12개 실카테고리로 낸 기여도를 화면 표시용 5개
  // 그룹으로 묶는다. 계산 자체(personalInflation)는 그대로 12개 실데이터
  // 기준이고, 이건 그 결과를 다시 합산만 하는 표시 레이어다.
  function aggregateByGroup(contributions, groups) {
    return groups.map((g) => {
      const members = contributions.filter((c) => g.members.includes(c.id));
      const amount = members.reduce((s, c) => s + c.amount, 0);
      const weight = members.reduce((s, c) => s + c.weight, 0);
      const contribution = members.reduce((s, c) => s + c.contribution, 0);
      const rate = weight > 0 ? contribution / weight : 0; // 가중평균 상승률
      return { id: g.id, name: g.name, hint: g.hint, amount, weight, rate, contribution };
    });
  }

  // 지출 비중을 고정한 채 10년을 되돌려 누적 물가를 계산한다.
  // 품목별 지수를 가중평균하므로 고정가중 라스파이레스 방식이다.
  function personalIndexPath(spending, categories) {
    const total = Object.values(spending).reduce((a, b) => a + (b || 0), 0);
    if (total <= 0) return null;

    const usable = categories.filter((c) => c.index && Object.keys(c.index).length);
    if (!usable.length) return null;

    // 모든 품목이 공통으로 가진 월만 사용
    let months = Object.keys(usable[0].index);
    for (const c of usable.slice(1)) {
      const has = new Set(Object.keys(c.index));
      months = months.filter((m) => has.has(m));
    }
    months.sort();
    if (months.length < 2) return null;

    const path = months.map((m) => {
      let acc = 0, w = 0;
      for (const cat of usable) {
        const amount = spending[cat.id] || 0;
        if (!amount) continue;
        acc += (amount / total) * cat.index[m];
        w += amount / total;
      }
      return { month: m, value: w > 0 ? acc / w : 100 };
    });

    const base = path[0].value;
    const norm = path.map((p) => ({ month: p.month, value: (p.value / base) * 100 }));
    return {
      path: norm,
      months,
      cumulative: norm[norm.length - 1].value / 100 - 1,
    };
  }

  // 구매력이 절반이 되기까지 걸리는 시간
  function halfLife(annualRate) {
    if (annualRate <= 0) return null;
    return Math.log(2) / Math.log(1 + annualRate);
  }

  /* ---------- 7. 연봉 성적 (종합 점수) ----------
     "실질임금 진단"과 "내 물가" 탭에서 이미 계산 중인 두 신호(실질임금
     성장·물가 방어)만 0~100점으로 정규화해 평균한다. 새 숫자를 만들어
     내는 게 아니라 있는 계산 결과를 다시 묶는 것뿐이다.

     목표 자산·투자 성향은 일부러 뺐다 — 목표 금액이나 위험 성향은
     사용자가 주관적으로 정하는 값이라, "연봉과 물가만 객관적으로
     비교한다"는 이 점수의 취지와 맞지 않는다.

     값이 없는 항목(연봉 미입력 등)은 평균에서 빼고 남은 항목만 쓴다.
     하나도 없으면 null — 화면에서 점수 대신 안내 문구를 보여준다.

     반올림은 각 항목을 clamp한 원값(raw)으로 평균을 낸 뒤 최종
     합계에만 한 번 적용한다 — 항목별로 먼저 반올림하면 오차가
     누적된다. item.score(반올림 값)는 세부 카드에 보여주기 위한
     표시용일 뿐 합계 계산에는 쓰지 않는다. */
  function salaryScore({ realRatePct, diffPp }) {
    const clamp = (n) => Math.min(100, Math.max(0, n));
    const items = [];

    // 실질 인상률 0%(명목 인상이 물가만큼만)를 중간(50점)으로 두고,
    // 1%p마다 10점씩 움직인다(±5%p에서 0점/100점).
    if (Number.isFinite(realRatePct)) {
      const raw = clamp(50 + realRatePct * 10);
      items.push({
        key: "wage", label: "실질임금 성장", raw, score: Math.round(raw),
        note: `실질 인상률 ${realRatePct >= 0 ? "+" : ""}${realRatePct.toFixed(1)}%`,
      });
    }

    // 내 물가가 공식 물가와 같으면 중간(50점), 1%p 낮을(유리) 때마다
    // 10점씩 오르고 높을(불리) 때마다 10점씩 내려간다(±5%p에서 만점/0점).
    if (Number.isFinite(diffPp)) {
      const raw = clamp(50 - diffPp * 10);
      items.push({
        key: "inflation", label: "물가 방어", raw, score: Math.round(raw),
        note: diffPp <= 0
          ? `내 물가가 공식보다 ${Math.abs(diffPp).toFixed(1)}%p 낮음`
          : `내 물가가 공식보다 ${diffPp.toFixed(1)}%p 높음`,
      });
    }

    if (!items.length) return null;
    const total = Math.round(items.reduce((sum, i) => sum + i.raw, 0) / items.length);
    return { total, items };
  }

  /* ---------- 유틸 ---------- */
  const monthToNum = (m) => {
    const [y, mm] = m.split("-").map(Number);
    return y * 12 + (mm - 1);
  };
  const monthLabel = (m) => {
    const [y, mm] = m.split("-");
    return `${y}.${mm}`;
  };
  const addMonths = (m, n) => {
    const t = monthToNum(m) + n;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
  };

  global.Engine = {
    diagnose, negotiate, project, requiredMonthly, monthsToGoal,
    backtest, backtestWindow, inflationPath, planOf,
    personalInflation, personalIndexPath, aggregateByGroup, halfLife, salaryScore,
    monthToNum, monthLabel, addMonths,
  };
})(window);
