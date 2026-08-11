/* ============================================================
   실시간 데이터 레이어

   설계 이유 — 왜 전부 실시간이 아닌가:
   브라우저에서 직접 부르려면 API가 CORS를 열어 줘야 한다. 실제로 확인해 보니
     · OECD(물가), Frankfurter(환율), CoinGecko(비트코인) → CORS 허용  ✅ 실시간
     · Yahoo Finance(주식·금·채권 시세)                    → CORS 미허용 ❌
   그래서 10년 시계열은 GitHub Actions가 주 1회 받아 스냅샷으로 커밋하고,
   지금 이 순간의 값이 의미 있는 지표만 페이지에서 직접 호출한다.

   또 하나의 이유: 발표 당일 여러 평가자가 동시에 접속한다. 모든 값을 외부 API에
   의존하면 한 곳만 느려도 화면이 빈다. 스냅샷을 바닥에 깔면 항상 그려지고,
   실시간이 성공하면 그 위에 덮어쓴다.
   ============================================================ */
(function (global) {
  "use strict";

  const TIMEOUT = 7000;

  async function getJSON(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function getCSV(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal, cache: "no-store",
        headers: { Accept: "application/vnd.sdmx.data+csv" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- 한국 소비자물가 상승률 (OECD) ---------- */
  const OECD_CPI =
    "https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0/" +
    "KOR.M.N.CPI.PA._T.N.GY?startPeriod=";

  async function fetchInflation() {
    const from = new Date();
    from.setMonth(from.getMonth() - 14);
    const start = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}`;
    const text = await getCSV(OECD_CPI + start);

    const lines = text.trim().split("\n");
    const head = lines[0].split(",");
    const iPeriod = head.indexOf("TIME_PERIOD");
    const iValue = head.indexOf("OBS_VALUE");
    if (iPeriod < 0 || iValue < 0) throw new Error("예상과 다른 CSV 형식");

    const rows = [];
    for (const line of lines.slice(1)) {
      const cells = line.split(",");
      const period = cells[iPeriod];
      const value = parseFloat(cells[iValue]);
      if (period && Number.isFinite(value)) rows.push({ period, value });
    }
    if (!rows.length) throw new Error("관측치 없음");

    rows.sort((a, b) => a.period.localeCompare(b.period));
    const last = rows[rows.length - 1];
    const prev = rows.length > 1 ? rows[rows.length - 2] : null;
    return {
      value: last.value,
      month: last.period,
      delta: prev ? last.value - prev.value : null,
      source: "OECD",
    };
  }

  /* ---------- 원/달러 환율 (Frankfurter) ---------- */
  async function fetchFx() {
    const data = await getJSON("https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW");
    const rate = data && data.rates && data.rates.KRW;
    if (!Number.isFinite(rate)) throw new Error("KRW 없음");
    return { value: rate, date: data.date, source: "Frankfurter (ECB)" };
  }

  /* ---------- 비트코인 (CoinGecko) ---------- */
  async function fetchBtc() {
    const data = await getJSON(
      "https://api.coingecko.com/api/v3/simple/price" +
      "?ids=bitcoin&vs_currencies=krw&include_24hr_change=true"
    );
    const row = data && data.bitcoin;
    if (!row || !Number.isFinite(row.krw)) throw new Error("가격 없음");
    return { value: row.krw, delta: row.krw_24h_change ?? null, source: "CoinGecko" };
  }

  /* ---------- 한꺼번에 받아오기 ---------- */
  // 하나가 실패해도 나머지는 살린다. 실패한 항목은 status로 알린다.
  async function fetchAll() {
    const jobs = {
      inflation: fetchInflation,
      fx: fetchFx,
      btc: fetchBtc,
    };
    const entries = await Promise.all(
      Object.entries(jobs).map(async ([key, fn]) => {
        try {
          return [key, { ok: true, data: await fn() }];
        } catch (err) {
          console.warn(`[live] ${key} 실패:`, err.message);
          return [key, { ok: false, error: err.message }];
        }
      })
    );
    return Object.fromEntries(entries);
  }

  global.Live = { fetchAll, fetchInflation, fetchFx, fetchBtc };
})(window);
