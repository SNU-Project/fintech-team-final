"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { window: {} };
vm.runInNewContext(fs.readFileSync("assets/js/engine.js", "utf8"), context);
const E = context.window.Engine;

function monthLabel(number) {
  return `${Math.floor(number / 12)}-${String((number % 12) + 1).padStart(2, "0")}`;
}

{
  const asset = { index: { "2020-01": 100, "2020-06": 110, "2022-01": 121 } };
  assert.equal(E.backtest(asset, "2020-02", 1000), null,
    "요청 시작월이 없으면 다음 관측월로 몰래 넘기면 안 됨");
  const result = E.backtest(asset, "2020-01", 1000);
  assert.equal(result.years, 2);
  assert.ok(Math.abs(result.cagr - 0.10) < 1e-12);
}

{
  const asset = { index: { "2020-01": 100, "2020-02": 110, "2020-03": 132 } };
  const result = E.backtest(asset, "2020-01", 1000, "2020-02");
  assert.equal(result.months.at(-1), "2020-02");
  assert.equal(result.finalValue, 1100,
    "자산과 물가의 공통 종료월 뒤 관측치는 비교에 들어가면 안 됨");

  const inflation = E.inflationPath(
    { "2020-01": 100, "2020-02": 101, "2020-03": 102 },
    "2020-01", 1000, "2020-02"
  );
  assert.equal(inflation.months.at(-1), "2020-02");
  assert.equal(inflation.path.at(-1).value, 1010);
}

{
  const start = E.monthToNum("2020-01");
  const index = {};
  for (let offset = 0; offset < 15; offset++) {
    if (offset === 6) continue;
    index[monthLabel(start + offset)] = 100 * (1.01 ** offset);
  }
  const result = E.backtest({ index }, "2020-01", 1000);
  assert.ok(result.volatility != null, "선택 구간 변동성을 반환해야 함");
  assert.ok(Math.abs(result.volatility) < 1e-12,
    "결측을 건너뛴 여러 달 수익률을 한 달 수익률로 취급하면 안 됨");
}

{
  const start = E.monthToNum("2020-01");
  const first = {}, second = {};
  let a = 100, b = 100;
  first[monthLabel(start)] = a;
  second[monthLabel(start)] = b;
  for (let offset = 1; offset <= 12; offset++) {
    const returnA = offset % 2 ? 0.10 : -0.10;
    a *= 1 + returnA;
    b *= 1 - returnA;
    first[monthLabel(start + offset)] = a;
    second[monthLabel(start + offset)] = b;
  }
  const market = {
    assets: [
      { id: "a", cagr: 0.05, volatility: 0.35, index: first },
      { id: "b", cagr: 0.05, volatility: 0.35, index: second },
    ],
  };
  const plan = E.customPlan(market, { a: 0.5, b: 0.5 });
  assert.ok(Math.abs(plan.expected_volatility) < 1e-12,
    "개별 변동성 가중평균이 아니라 공통 월 포트폴리오 수익률을 써야 함");
  assert.equal(plan.volatility_method, "common_consecutive_monthly_returns");
}

console.log("engine tests passed");
