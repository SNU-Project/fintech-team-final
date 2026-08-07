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
    personalInflation, personalIndexPath, halfLife,
    monthToNum, monthLabel, addMonths,
  };
})(window);
