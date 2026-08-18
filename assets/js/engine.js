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

  // 결측 전후의 여러 달짜리 변화를 한 달 수익률로 취급하지 않는다.
  // 달력상 정확히 한 달 차이인 실제 관측쌍만 쓰고, 값을 보간하지 않는다.
  function consecutiveMonthlyReturns(index, selectedMonths = null) {
    const months = selectedMonths || Object.keys(index || {}).sort();
    const returns = new Map();
    for (let i = 1; i < months.length; i++) {
      const prev = months[i - 1], cur = months[i];
      if (monthToNum(cur) - monthToNum(prev) !== 1) continue;
      const before = index[prev], after = index[cur];
      if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0 || after <= 0) continue;
      returns.set(cur, after / before - 1);
    }
    return returns;
  }

  function annualizedVolatility(returns) {
    if (!returns || returns.length < 12) return null;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (returns.length - 1);
    return Math.sqrt(variance) * Math.sqrt(12);
  }

  // 모든 구성자산에 공통으로 존재하는 연속 월만 골라, 매월 같은 비중으로
  // 재조정한 포트폴리오 수익률 Σ(비중×월수익률)의 실제 변동성을 구한다.
  function portfolioVolatility(market, weights) {
    if (!market || !Array.isArray(market.assets)) return null;
    const byId = Object.fromEntries(market.assets.map((asset) => [asset.id, asset]));
    const entries = Object.entries(weights || {}).filter(([, weight]) => weight > 0);
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    if (total <= 0 || entries.some(([id]) => !byId[id] || !byId[id].index)) return null;

    const normalized = Object.fromEntries(entries.map(([id, weight]) => [id, weight / total]));
    const returnsById = Object.fromEntries(entries.map(([id]) =>
      [id, consecutiveMonthlyReturns(byId[id].index)]));
    if (Object.values(returnsById).some((returns) => returns.size === 0)) return null;

    let common = null;
    for (const returns of Object.values(returnsById)) {
      const months = new Set(returns.keys());
      common = common == null ? months : new Set([...common].filter((month) => months.has(month)));
    }
    const portfolioReturns = [...(common || [])].sort().map((month) =>
      entries.reduce((sum, [id]) => sum + normalized[id] * returnsById[id].get(month), 0));
    return annualizedVolatility(portfolioReturns);
  }

  /* ---------- 4. 백테스트 (자산 타임머신) ---------- */
  // 실제 월말 종가 인덱스를 그대로 사용한다. 곡선을 만들어내지 않는다.
  function backtest(asset, startMonth, amount, endMonth = null) {
    if (!asset || !Number.isFinite(amount) || amount <= 0) return null;
    const idx = asset.index || {};
    // 요청한 달이 없는데 다음 관측월을 시작점인 것처럼 쓰면 화면의 날짜와
    // 계산 기준이 달라진다. 정확한 시작월이 없으면 없다고 반환한다.
    if (!Object.prototype.hasOwnProperty.call(idx, startMonth)) return null;
    const months = Object.keys(idx).sort()
      .filter((m) => m >= startMonth && (!endMonth || m <= endMonth));
    if (months.length < 2) return null;

    const base = idx[startMonth];
    if (!Number.isFinite(base) || base <= 0) return null;

    const path = months.map((m) => ({
      month: m,
      value: (idx[m] / base) * amount,
    }));

    const finalValue = path[path.length - 1].value;
    const elapsedMonths = monthToNum(months[months.length - 1]) - monthToNum(startMonth);
    const years = elapsedMonths / 12;
    const totalReturn = finalValue / amount - 1;
    const cagr = years > 0 ? Math.pow(finalValue / amount, 1 / years) - 1 : 0;
    const volatility = annualizedVolatility(
      [...consecutiveMonthlyReturns(idx, months).values()]
    );

    // 이 구간만의 최대 낙폭
    let peak = -Infinity, mdd = 0;
    for (const p of path) {
      if (p.value > peak) peak = p.value;
      else if (peak > 0) mdd = Math.min(mdd, p.value / peak - 1);
    }

    return { path, finalValue, totalReturn, cagr, volatility, mdd, months, years };
  }

  // 특정 시작 달 하나의 우연을 결과로 오해하지 않도록 앞뒤 달의 실제 결과도
  // 함께 계산한다. 결측 월은 보간하지 않고, 실제 관측치가 있는 달만 쓴다.
  function backtestWindow(asset, startMonth, amount, radius = 6, endMonth = null) {
    const byObservedMonth = new Map();
    for (let offset = -radius; offset <= radius; offset++) {
      const requested = addMonths(startMonth, offset);
      const bt = backtest(asset, requested, amount, endMonth);
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
    const selected = backtest(asset, startMonth, amount, endMonth);

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
  function inflationPath(cpiIndex, startMonth, amount, endMonth = null) {
    if (!Object.prototype.hasOwnProperty.call(cpiIndex || {}, startMonth)) return null;
    const months = Object.keys(cpiIndex).sort()
      .filter((m) => m >= startMonth && (!endMonth || m <= endMonth));
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
  /* 사용자가 직접 맞춘 비중으로 포트폴리오를 만든다.
     기대수익률은 실제 CAGR 가중평균, 변동성은 공통 월의 포트폴리오
     수익률로 계산해 파이프라인의 프리셋과 같은 잣대로 비교한다. */
  function customPlan(market, weights) {
    const byId = Object.fromEntries(market.assets.map((a) => [a.id, a]));
    const entries = Object.entries(weights).filter(([id, w]) => byId[id] && w > 0);
    const total = entries.reduce((s, [, w]) => s + w, 0);
    if (total <= 0) return null;

    const expected = entries.reduce((s, [id, w]) => s + byId[id].cagr * w, 0) / total;
    const actualVol = portfolioVolatility(market, Object.fromEntries(entries));
    // 공통 연속 월 수익률이 12개 미만일 때만 기존 가중평균을 fallback으로
    // 쓴다. 0은 완전 상쇄된 유효 결과일 수 있으므로 null과 구분한다.
    const vol = actualVol == null
      ? entries.reduce((s, [id, w]) => s + (byId[id].volatility || 0) * w, 0) / total
      : actualVol;
    const items = entries
      .map(([id, w]) => ({ id, weight: w / total, asset: byId[id] }))
      .sort((a, b) => b.weight - a.weight);

    return {
      key: "custom",
      label: "직접 조정",
      desc: "비중을 직접 맞춘 배분입니다.",
      weights: Object.fromEntries(items.map((i) => [i.id, i.weight])),
      expected_return: expected,
      expected_volatility: vol,
      volatility_method: actualVol == null
        ? "weighted_asset_volatility_fallback"
        : "common_consecutive_monthly_returns",
      items,
    };
  }

  /* 변동성 몇 %는 잘 안 와닿는다. "나쁜 해에는 이 정도까지 빠질 수 있다"로
     번역한다. 정규분포 가정에서 하위 2.5% 수준(평균 - 2σ)을 쓴다.
     실제 최악은 이보다 깊을 수 있으므로 화면에서 '대략'임을 밝힌다. */
  function badYear(expectedReturn, volatility) {
    return expectedReturn - 2 * volatility;
  }

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

  /* ---------- 물가 추이 예측 (단순 선형회귀) ----------
     "ML"이라는 표현에 얽매이지 않고, 검증 가능한 가장 단순한 통계
     방법(최소제곱 선형추세)을 쓴다 — 최근 historyMonths개월의 실제
     YoY 물가상승률에 직선을 적합해 forecastMonths개월을 연장한다.
     정밀 예측이 아니라 "지금 추세가 이어지면"이라는 참고용 추세선이라
     화면에도 반드시 "예측치" 안내를 병기해야 한다. */
  function forecastLinear(monthlySeries, { historyMonths = 36, forecastMonths = 12 } = {}) {
    const months = Object.keys(monthlySeries).sort();
    const recent = months.slice(-historyMonths);
    const n = recent.length;
    if (n < 2) return null;

    const xs = recent.map((_, i) => i);
    const ys = recent.map((m) => monthlySeries[m]);
    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = ys.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
    const sumXX = xs.reduce((s, x) => s + x * x, 0);
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return null;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    const history = recent.map((m, i) => ({ month: m, value: ys[i] }));
    const forecast = [];
    let cursor = recent[n - 1];
    for (let k = 1; k <= forecastMonths; k++) {
      cursor = addMonths(cursor, 1);
      forecast.push({ month: cursor, value: slope * (n - 1 + k) + intercept });
    }
    return { history, forecast, slope };
  }

  /* ---------- 물가 추이 예측 (AR(2)) ----------
     직선추세는 최근 3년이 내려가는 구간이라 그 기울기를 그대로 미래로
     늘렸고, 마지막 실측(2.8%)에서 2.0%로 뚝 떨어지는 계단이 생겼다.
     물가상승률은 평균으로 되돌아오는 성질이 있어 AR(2)가 훨씬 매끄럽다.
     과거 79개 시점 백테스트에서도 오차가 더 작았다(2.68 → 1.98%p).

     ⚠️ 이 선은 참고용이다. 진단·목표·타임머신은 전부 실제 관측값으로
     계산한다. 화면의 "예측치" 안내를 지우지 말 것.

     모형: y(t) = c + φ1·y(t-1) + φ2·y(t-2), 최소제곱 추정 */
  function fitAR2(values) {
    const p = 2;
    const rows = [];
    for (let t = p; t < values.length; t++) {
      rows.push([1, values[t - 1], values[t - 2], values[t]]);
    }
    if (rows.length < 6) return null;

    // 정규방정식 XᵀX·b = Xᵀy 를 만들고 가우스 소거로 푼다
    const k = 3;
    const A = [];
    for (let i = 0; i < k; i++) {
      const row = [];
      for (let j = 0; j < k; j++) {
        row.push(rows.reduce((s, r) => s + r[i] * r[j], 0));
      }
      row.push(rows.reduce((s, r) => s + r[i] * r[3], 0));
      A.push(row);
    }
    for (let c = 0; c < k; c++) {
      let pivot = c;
      for (let r = c + 1; r < k; r++) {
        if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
      }
      [A[c], A[pivot]] = [A[pivot], A[c]];
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (let r = 0; r < k; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
      }
    }
    const b = A.map((row, i) => row[k] / A[i][i]);
    if (!b.every(Number.isFinite)) return null;
    return { c: b[0], phi1: b[1], phi2: b[2] };
  }

  function forecastAR2(monthlySeries, { historyMonths = 36, forecastMonths = 12 } = {}) {
    const months = Object.keys(monthlySeries).sort();
    const recent = months.slice(-historyMonths);
    if (recent.length < 8) return null;

    const values = recent.map((m) => monthlySeries[m]);
    const model = fitAR2(values);
    if (!model) return null;

    // φ1+φ2 >= 1 이면 발산한다. 그런 표본이 나오면 선을 그리지 않는다 —
    // 물가가 무한히 오르는 그래프를 보여주느니 카드를 숨기는 게 낫다.
    if (model.phi1 + model.phi2 >= 0.999) return null;

    const history = recent.map((m, i) => ({ month: m, value: values[i] }));
    const forecast = [];
    const buffer = values.slice(-2);
    let cursor = recent[recent.length - 1];
    for (let k = 0; k < forecastMonths; k++) {
      const next = model.c
        + model.phi1 * buffer[buffer.length - 1]
        + model.phi2 * buffer[buffer.length - 2];
      buffer.push(next);
      cursor = addMonths(cursor, 1);
      forecast.push({ month: cursor, value: next });
    }
    // 장기평균 = c / (1 - φ1 - φ2). 이 값으로 수렴한다.
    const longRun = model.c / (1 - model.phi1 - model.phi2);
    return { history, forecast, model, longRun };
  }

  global.Engine = {
    diagnose, negotiate, project, requiredMonthly, monthsToGoal,
    backtest, backtestWindow, inflationPath, planOf, customPlan, badYear,
    portfolioVolatility,
    personalInflation, personalIndexPath, aggregateByGroup,
    monthToNum, monthLabel, addMonths, forecastLinear, forecastAR2,
  };
})(window);
