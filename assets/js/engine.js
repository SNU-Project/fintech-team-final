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

  /* ---------- 4. 백테스트 (자산 타임머신) ---------- */
  // 실제 월말 종가 인덱스를 그대로 사용한다. 곡선을 만들어내지 않는다.
  function backtest(asset, startMonth, amount) {
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
    diagnose, negotiate, project, requiredMonthly,
    backtest, inflationPath, planOf,
    monthToNum, monthLabel, addMonths,
  };
})(window);
