"""실데이터 수집 스크립트.

두 곳에서만 데이터를 가져온다.
  - Yahoo Finance chart API : 자산별 월말 종가 (무키)
  - OECD SDMX               : 한국 소비자물가지수 월별 (무키)

원칙: 네트워크 실패 시 절대로 값을 지어내지 않는다. 예외를 던지고 멈춘다.
합성 데이터를 백테스트로 보여주면 그 순간 결과물 전체의 신뢰가 무너지기 때문이다.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import pathlib
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

YEARS = 10
UA = "Mozilla/5.0 (compatible; SNU-fintech-team/1.0)"

# 통화가 USD인 자산은 원/달러 환율로 환산해 "한국인 투자자 기준 수익률"로 맞춘다.
ASSETS = [
    {"id": "kodex200", "name": "KODEX 200",       "symbol": "069500.KS", "currency": "KRW",
     "category": "국내주식", "desc": "코스피200 추종 ETF"},
    {"id": "sp500",    "name": "S&P 500",          "symbol": "^GSPC",     "currency": "USD",
     "category": "해외주식", "desc": "미국 대표지수"},
    {"id": "gold",     "name": "금",               "symbol": "GC=F",      "currency": "USD",
     "category": "실물",     "desc": "국제 금 선물"},
    {"id": "bond10y",  "name": "KODEX 국고채10년", "symbol": "148070.KS", "currency": "KRW",
     "category": "채권",     "desc": "국고채 10년 추종 ETF"},
    {"id": "bitcoin",  "name": "비트코인",         "symbol": "BTC-USD",   "currency": "USD",
     "category": "암호자산", "desc": "BTC 현물"},
]

FX_SYMBOL = "KRW=X"  # 원/달러

YAHOO_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    "?range={years}y&interval=1mo"
)

# KOR = 한국, M = 월별, CPI, IX = 지수(2015=100 계열), _T = 전체품목
OECD_CPI_URL = (
    "https://sdmx.oecd.org/public/rest/data/"
    "OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0/"
    "KOR.M.N.CPI.{measure}._T.N.{transform}?startPeriod={start}"
)


class DataFetchError(RuntimeError):
    """수집 실패. 호출부는 이걸 잡아서 합성값으로 때우면 안 된다."""


def _get(url: str, accept: str | None = None, retries: int = 3) -> bytes:
    headers = {"User-Agent": UA}
    if accept:
        headers["Accept"] = accept
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=45) as resp:
                if resp.status != 200:
                    raise DataFetchError(f"HTTP {resp.status} — {url}")
                return resp.read()
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
    raise DataFetchError(f"{url} 요청 실패: {last}")


def fetch_monthly_closes(symbol: str) -> dict[str, float]:
    """{'YYYY-MM': 종가} 형태로 월말 종가를 돌려준다."""
    raw = json.loads(_get(YAHOO_URL.format(symbol=symbol, years=YEARS)))
    chart = raw.get("chart") or {}
    if chart.get("error"):
        raise DataFetchError(f"{symbol}: {chart['error']}")
    result = (chart.get("result") or [None])[0]
    if not result:
        raise DataFetchError(f"{symbol}: 응답에 result 없음")

    stamps = result.get("timestamp") or []
    closes = result["indicators"]["quote"][0].get("close") or []
    if not stamps or not closes:
        raise DataFetchError(f"{symbol}: 시계열이 비어 있음")

    # 월봉 타임스탬프는 거래소 현지시간 기준 월초를 가리킨다. UTC로 그냥 변환하면
    # KST 10월 1일 00:00이 UTC 9월 30일로 밀려 9월을 덮어쓴다(매년 10월 소실).
    # 응답이 알려주는 gmtoffset을 더해 현지 날짜로 되돌린 뒤 월을 뽑는다.
    offset = dt.timedelta(seconds=int(result.get("meta", {}).get("gmtoffset") or 0))

    series: dict[str, float] = {}
    for ts, close in zip(stamps, closes):
        if close is None:
            continue  # 결측월은 버린다 (보간하지 않음)
        month = (dt.datetime.fromtimestamp(ts, dt.UTC) + offset).strftime("%Y-%m")
        series[month] = float(close)

    if len(series) < 24:
        raise DataFetchError(f"{symbol}: 유효 관측치 {len(series)}개뿐 — 최소 24개 필요")
    return series


def reject_outliers(series: dict[str, float], label: str,
                    jump: float = 5.0) -> tuple[dict[str, float], list[str]]:
    """자릿수가 어긋난 단일 오류 틱만 걷어낸다.

    Yahoo는 드물게 잘못된 값을 섞어 준다(예: 원/달러 2017-09에 0.1154).
    이런 값 하나가 최대낙폭을 -100%로, 변동성을 수십만 %로 만들어 버린다.

    주의: '중앙값 대비 몇 배'로 거르면 안 된다. 비트코인처럼 10년간 실제로
    100배 오른 자산의 정상 구간까지 잘려 나간다. 오류 틱의 특징은 크기가 아니라
    '한 달 만에 튀었다가 바로 되돌아오는' 모양이므로, 들어가는 변화율과
    나오는 변화율이 서로 반대 방향으로 극단적인 지점만 제거한다.
    보간은 하지 않고 그냥 빼며, 무엇을 뺐는지 기록한다.
    """
    months = sorted(series)
    if len(months) < 3:
        return series, []

    bad, dropped = set(), []
    for i in range(1, len(months) - 1):
        prev, cur, nxt = series[months[i - 1]], series[months[i]], series[months[i + 1]]
        if prev <= 0 or cur <= 0:
            continue
        r_in, r_out = cur / prev, nxt / cur
        spike_down = r_in < 1 / jump and r_out > jump
        spike_up = r_in > jump and r_out < 1 / jump
        if spike_down or spike_up:
            bad.add(months[i])
            dropped.append(
                f"{label} {months[i]}: {cur:,.4f} — 전월 대비 {r_in:.4g}배 후 "
                f"익월 {r_out:.4g}배로 복귀, 단일 오류 틱으로 판단해 제외"
            )

    return {m: v for m, v in series.items() if m not in bad}, dropped


def fetch_oecd_cpi(measure: str, transform: str, start: str) -> dict[str, float]:
    """OECD SDMX에서 한국 CPI 월별 시리즈를 가져온다."""
    url = OECD_CPI_URL.format(measure=measure, transform=transform, start=start)
    text = _get(url, accept="application/vnd.sdmx.data+csv").decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))

    series: dict[str, float] = {}
    for row in reader:
        period = (row.get("TIME_PERIOD") or "").strip()
        value = (row.get("OBS_VALUE") or "").strip()
        if not period or not value:
            continue
        try:
            series[period] = float(value)
        except ValueError:
            continue

    if len(series) < 24:
        raise DataFetchError(f"OECD CPI({measure}/{transform}): 관측치 {len(series)}개뿐")
    return dict(sorted(series.items()))


def to_krw(series: dict[str, float], fx: dict[str, float], asset_id: str) -> dict[str, float]:
    """USD 표시 자산을 원화로 환산한다. 환율이 없는 달은 통째로 제외."""
    converted = {}
    missing = 0
    for month, price in series.items():
        rate = fx.get(month)
        if rate is None:
            missing += 1
            continue
        converted[month] = price * rate
    if not converted:
        raise DataFetchError(f"{asset_id}: 환율 겹치는 구간이 없음")
    if missing:
        print(f"    · {asset_id}: 환율 없는 {missing}개월 제외")
    return converted


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fetched_at = dt.datetime.now(dt.UTC)

    cleaning_log: list[str] = []

    print("[1/3] 원/달러 환율 수집")
    fx = fetch_monthly_closes(FX_SYMBOL)
    fx, dropped = reject_outliers(fx, "원/달러")
    cleaning_log += dropped
    for d in dropped:
        print(f"    ! {d}")
    print(f"    · {len(fx)}개월 ({min(fx)} ~ {max(fx)})")

    print("[2/3] 자산별 월말 종가 수집")
    raw_series: dict[str, dict[str, float]] = {}
    for asset in ASSETS:
        series = fetch_monthly_closes(asset["symbol"])
        series, dropped = reject_outliers(series, asset["name"])
        cleaning_log += dropped
        for d in dropped:
            print(f"    ! {d}")
        note = ""
        if asset["currency"] == "USD":
            series = to_krw(series, fx, asset["id"])
            note = " → 원화 환산"
        raw_series[asset["id"]] = series
        print(f"    · {asset['name']:<18} {len(series):>3}개월{note}")

    print("[3/3] 한국 소비자물가지수 수집 (OECD)")
    start = f"{fetched_at.year - YEARS}-01"
    cpi_index = fetch_oecd_cpi("IX", "_Z", start)
    cpi_yoy = fetch_oecd_cpi("PA", "GY", start)
    print(f"    · 지수 {len(cpi_index)}개월, 전년동월비 {len(cpi_yoy)}개월 "
          f"({min(cpi_index)} ~ {max(cpi_index)})")

    payload = {
        "fetched_at": fetched_at.isoformat(timespec="seconds"),
        "fx": fx,
        "assets": [
            {**asset, "series": raw_series[asset["id"]]}
            for asset in ASSETS
        ],
        "cpi": {"index": cpi_index, "yoy": cpi_yoy},
        "cleaning_log": cleaning_log,
    }

    out = DATA_DIR / "_raw.json"
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"\n원본 저장: {out.relative_to(ROOT)}  ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
