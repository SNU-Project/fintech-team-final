"""수집 원본(_raw.json)을 화면이 바로 쓸 수 있는 형태로 정제한다.

하는 일
  1. 자산별 월말 종가 → 100 기준 성장지수로 정규화
  2. CAGR(연평균 수익률), 연환산 변동성, MDD(최대 낙폭) 산출
  3. 소비자물가지수로 실질 수익률(= 물가를 이긴 부분) 계산
  4. 포트폴리오 유형별 기대수익률을 실제 자산 수익률에서 역산

여기서도 값을 지어내지 않는다. 계산에 쓸 관측치가 모자라면 그 항목을 빼고,
왜 뺐는지 meta에 남긴다.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

# 투자성향별 자산 배분. 비중은 팀 요구사항 정의서를 따르고,
# 기대수익률은 아래에서 실제 시장 데이터로 역산한다(하드코딩하지 않음).
PORTFOLIOS = {
    "stable": {
        "label": "안정형",
        "desc": "원금 변동을 줄이고 예금 위주로 부족분을 메웁니다.",
        "weights": {"cash": 0.60, "bond10y": 0.20, "kodex200": 0.20},
    },
    "balanced": {
        "label": "균형형",
        "desc": "저축과 투자를 고르게 섞어 위험과 수익의 균형을 맞춥니다.",
        "weights": {"cash": 0.40, "bond10y": 0.20, "kodex200": 0.20, "sp500": 0.20},
    },
    "aggressive": {
        "label": "적극형",
        "desc": "변동성을 감수하고 주식·실물 비중을 높입니다.",
        "weights": {"cash": 0.10, "bond10y": 0.10, "kodex200": 0.30, "sp500": 0.35, "gold": 0.15},
    },
}

# 예금은 시장 시세가 없다. 한국은행 기준금리 수준을 반영한 고정 가정이며
# 화면에도 '가정값'으로 명시한다. (다른 자산은 전부 실제 시세 기반)
CASH_ANNUAL_RETURN = 0.030


def cagr(series: dict[str, float]) -> float | None:
    """연평균 복리 수익률. 관측 구간이 1년 미만이면 None."""
    months = sorted(series)
    if len(months) < 13:
        return None
    first, last = series[months[0]], series[months[-1]]
    if first <= 0:
        return None
    years = len(months) / 12
    return (last / first) ** (1 / years) - 1


def annual_volatility(series: dict[str, float]) -> float | None:
    """월 수익률 표준편차를 연환산."""
    months = sorted(series)
    rets = []
    for prev, cur in zip(months, months[1:]):
        if series[prev] > 0:
            rets.append(series[cur] / series[prev] - 1)
    if len(rets) < 12:
        return None
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return math.sqrt(var) * math.sqrt(12)


def max_drawdown(series: dict[str, float]) -> dict | None:
    """고점 대비 최대 낙폭과 그 시점."""
    months = sorted(series)
    if len(months) < 2:
        return None
    peak, peak_month = series[months[0]], months[0]
    worst, worst_at, worst_from = 0.0, None, None
    for m in months:
        price = series[m]
        if price > peak:
            peak, peak_month = price, m
        elif peak > 0:
            dd = price / peak - 1
            if dd < worst:
                worst, worst_at, worst_from = dd, m, peak_month
    if worst_at is None:
        return None
    return {"depth": worst, "trough": worst_at, "peak": worst_from}


def normalize(series: dict[str, float], base: str | None = None) -> dict[str, float]:
    """시작 시점을 100으로 맞춘 성장지수."""
    months = sorted(series)
    start = base if base and base in series else months[0]
    anchor = series[start]
    if anchor <= 0:
        return {}
    return {m: round(series[m] / anchor * 100, 3) for m in months if m >= start}


def window(series: dict[str, float], years: int) -> dict[str, float]:
    months = sorted(series)
    keep = months[-(years * 12 + 1):]
    return {m: series[m] for m in keep}


def main() -> None:
    raw = json.loads((DATA_DIR / "_raw.json").read_text(encoding="utf-8"))
    # 수집 단계에서 걸러낸 값들을 그대로 이어받아 화면의 '계산 근거'에 노출한다.
    notes: list[str] = list(raw.get("cleaning_log", []))

    cpi_index = raw["cpi"]["index"]
    cpi_yoy = raw["cpi"]["yoy"]
    latest_cpi_month = max(cpi_yoy)
    latest_inflation = cpi_yoy[latest_cpi_month]

    # 자산별 지표
    assets = []
    returns_by_id: dict[str, float] = {}
    for asset in raw["assets"]:
        series = asset["series"]
        full_cagr = cagr(series)
        if full_cagr is None:
            notes.append(f"{asset['name']}: 관측 구간이 짧아 제외")
            continue
        returns_by_id[asset["id"]] = full_cagr

        entry = {
            "id": asset["id"],
            "name": asset["name"],
            "category": asset["category"],
            "desc": asset["desc"],
            "symbol": asset["symbol"],
            "currency": asset["currency"],
            "krw_converted": asset["currency"] != "KRW",
            "months": len(series),
            "range": [min(series), max(series)],
            "cagr": round(full_cagr, 5),
            "cagr_1y": round(cagr(window(series, 1)) or 0, 5) if cagr(window(series, 1)) else None,
            "cagr_3y": round(cagr(window(series, 3)) or 0, 5) if cagr(window(series, 3)) else None,
            "cagr_5y": round(cagr(window(series, 5)) or 0, 5) if cagr(window(series, 5)) else None,
            "volatility": round(annual_volatility(series) or 0, 5),
            "mdd": max_drawdown(series),
            "index": normalize(series),
            "last_price": series[max(series)],
            "last_month": max(series),
        }
        if entry["mdd"]:
            entry["mdd"]["depth"] = round(entry["mdd"]["depth"], 5)
        assets.append(entry)

    # 예금은 시세가 없으므로 가정 수익률로 합성 지수를 만든다(명시적으로 표시).
    any_months = sorted(raw["assets"][0]["series"])
    cash_series = {
        m: 100 * (1 + CASH_ANNUAL_RETURN) ** (i / 12)
        for i, m in enumerate(any_months)
    }
    returns_by_id["cash"] = CASH_ANNUAL_RETURN
    assets.append({
        "id": "cash", "name": "예금·적금", "category": "저축", "desc": "정기예금 등 원금보장형",
        "symbol": None, "currency": "KRW", "krw_converted": False,
        "months": len(cash_series), "range": [min(cash_series), max(cash_series)],
        "cagr": CASH_ANNUAL_RETURN, "cagr_1y": CASH_ANNUAL_RETURN,
        "cagr_3y": CASH_ANNUAL_RETURN, "cagr_5y": CASH_ANNUAL_RETURN,
        "volatility": 0.0, "mdd": None,
        "index": {m: round(v, 3) for m, v in cash_series.items()},
        "last_price": None, "last_month": max(cash_series),
        "assumed": True,
    })

    # 포트폴리오 기대수익률 = 구성자산 실제 CAGR의 가중평균
    portfolios = {}
    for key, cfg in PORTFOLIOS.items():
        weights = cfg["weights"]
        missing = [a for a in weights if a not in returns_by_id]
        if missing:
            notes.append(f"{cfg['label']}: {', '.join(missing)} 수익률 없음 — 비중 재정규화")
        usable = {a: w for a, w in weights.items() if a in returns_by_id}
        total_w = sum(usable.values()) or 1
        expected = sum(returns_by_id[a] * w for a, w in usable.items()) / total_w
        vol = sum(
            (next((x["volatility"] for x in assets if x["id"] == a), 0)) * w
            for a, w in usable.items()
        ) / total_w
        portfolios[key] = {
            "label": cfg["label"],
            "desc": cfg["desc"],
            "weights": {a: round(w / total_w, 4) for a, w in usable.items()},
            "expected_return": round(expected, 5),
            "expected_volatility": round(vol, 5),
            "real_return": round(expected - latest_inflation / 100, 5),
        }

    market = {
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "source_fetched_at": raw["fetched_at"],
        "assets": assets,
        "portfolios": portfolios,
        "cash_assumption": CASH_ANNUAL_RETURN,
        "notes": notes,
    }

    cpi = {
        "index": cpi_index,
        "yoy": cpi_yoy,
        "latest": {"month": latest_cpi_month, "yoy": round(latest_inflation, 3)},
        "source": "OECD SDMX · Consumer Price Index, Korea",
    }

    meta = {
        "generated_at": market["generated_at"],
        "sources": [
            {"name": "Yahoo Finance chart API", "use": "자산별 월말 종가 10년",
             "url": "https://query1.finance.yahoo.com", "live_in_browser": False,
             "reason": "CORS 미허용 — GitHub Actions가 매일 수집해 스냅샷으로 커밋"},
            {"name": "OECD SDMX", "use": "한국 소비자물가지수(월)",
             "url": "https://sdmx.oecd.org", "live_in_browser": True},
            {"name": "Frankfurter", "use": "원/달러 환율(실시간)",
             "url": "https://api.frankfurter.dev", "live_in_browser": True},
            {"name": "CoinGecko", "use": "비트코인 시세(실시간)",
             "url": "https://api.coingecko.com", "live_in_browser": True},
        ],
        "assumptions": [
            f"예금 수익률 {CASH_ANNUAL_RETURN:.1%}는 시세가 아닌 고정 가정값입니다.",
            "USD 표시 자산(S&P500·금·비트코인)은 원/달러 환율로 환산한 원화 기준 수익률입니다.",
            "세금·거래비용·배당은 반영하지 않았습니다.",
        ],
        "notes": notes,
    }

    for name, payload in (("market", market), ("cpi", cpi), ("meta", meta)):
        path = DATA_DIR / f"{name}.json"
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"  {path.name:<12} {path.stat().st_size / 1024:>6.1f} KB")

    print(f"\n최신 물가상승률: {latest_inflation:.2f}% ({latest_cpi_month})")
    for a in assets:
        mdd = f"{a['mdd']['depth']:+.1%}" if a["mdd"] else "  —  "
        flag = " (가정)" if a.get("assumed") else ""
        print(f"  {a['name']:<16} CAGR {a['cagr']:+.2%}  변동성 {a['volatility']:.1%}  MDD {mdd}{flag}")
    print()
    for key, p in portfolios.items():
        print(f"  {p['label']:<5} 기대 {p['expected_return']:+.2%}  실질 {p['real_return']:+.2%}")
    if notes:
        print("\n메모:")
        for n in notes:
            print(f"  · {n}")


if __name__ == "__main__":
    main()
