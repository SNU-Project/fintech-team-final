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
    "KOR.M.N.CPI.{measure}.{expenditure}.N.{transform}?startPeriod={start}"
)

# COICOP 12대 분류. "내 물가"는 이 품목별 상승률을 사용자의 지출 비중으로
# 가중평균해 계산한다. 공식 물가(2.8%)는 전국 평균 가중치를 쓴 값이라
# 개인의 체감과 다를 수밖에 없다는 것이 이 기능의 출발점이다.
CPI_CATEGORIES = [
    {"code": "CP01", "id": "food",      "name": "식료품·비주류음료", "hint": "장보기, 집에서 먹는 식재료"},
    {"code": "CP02", "id": "alcohol",   "name": "주류·담배",        "hint": "술, 담배"},
    {"code": "CP03", "id": "clothing",  "name": "의류·신발",        "hint": "옷, 신발, 세탁"},
    {"code": "CP04", "id": "housing",   "name": "주거·수도·광열",   "hint": "월세, 관리비, 전기·가스·수도"},
    {"code": "CP05", "id": "household", "name": "가정용품·가사서비스", "hint": "가구, 생활용품, 청소·세탁 서비스"},
    {"code": "CP06", "id": "health",    "name": "보건",             "hint": "병원비, 약값, 건강보조"},
    {"code": "CP07", "id": "transport", "name": "교통",             "hint": "기름값, 대중교통, 차량 유지"},
    {"code": "CP08", "id": "comm",      "name": "통신",             "hint": "휴대폰 요금, 인터넷"},
    {"code": "CP09", "id": "leisure",   "name": "오락·문화",        "hint": "여행, 취미, 구독 서비스"},
    {"code": "CP10", "id": "education", "name": "교육",             "hint": "학원, 등록금, 교재"},
    {"code": "CP11", "id": "dining",    "name": "음식·숙박",        "hint": "외식, 배달, 카페, 숙박"},
    {"code": "CP12", "id": "misc",      "name": "기타 상품·서비스", "hint": "미용, 보험, 금융수수료"},
]


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


def fetch_oecd_cpi(measure: str, transform: str, start: str,
                   expenditure: str = "_T") -> dict[str, float]:
    """OECD SDMX에서 한국 CPI 월별 시리즈를 가져온다.

    expenditure="_T"면 전체 품목(공식 물가), CP01~CP12면 해당 품목만.
    """
    url = OECD_CPI_URL.format(measure=measure, transform=transform,
                              start=start, expenditure=expenditure)
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


def fetch_oecd_cpi_by_category(measure: str, transform: str, start: str,
                               codes: list[str]) -> dict[str, dict[str, float]]:
    """12개 품목을 한 번의 요청으로 받아 품목코드별로 갈라 돌려준다.

    품목마다 따로 부르면 24회 연속 호출이 되어 OECD가 429로 막는다.
    SDMX는 `CP01+CP02+...` 형태로 여러 코드를 한 번에 받으므로 그걸 쓴다.
    """
    joined = "+".join(codes)
    url = OECD_CPI_URL.format(measure=measure, transform=transform,
                              start=start, expenditure=joined)
    text = _get(url, accept="application/vnd.sdmx.data+csv").decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))

    out: dict[str, dict[str, float]] = {c: {} for c in codes}
    for row in reader:
        code = (row.get("EXPENDITURE") or "").strip()
        period = (row.get("TIME_PERIOD") or "").strip()
        value = (row.get("OBS_VALUE") or "").strip()
        if code not in out or not period or not value:
            continue
        try:
            out[code][period] = float(value)
        except ValueError:
            continue

    empty = [c for c, s in out.items() if len(s) < 24]
    if empty:
        raise DataFetchError(f"품목별 물가 부족: {', '.join(empty)}")
    return {c: dict(sorted(s.items())) for c, s in out.items()}


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

    print("[3/4] 한국 소비자물가지수 수집 (OECD)")
    start = f"{fetched_at.year - YEARS}-01"
    cpi_index = fetch_oecd_cpi("IX", "_Z", start)
    cpi_yoy = fetch_oecd_cpi("PA", "GY", start)
    print(f"    · 지수 {len(cpi_index)}개월, 전년동월비 {len(cpi_yoy)}개월 "
          f"({min(cpi_index)} ~ {max(cpi_index)})")

    print("[4/4] 품목별 물가 수집 (COICOP 12분류) — 요청 2회로 일괄 수신")
    codes = [c["code"] for c in CPI_CATEGORIES]
    yoy_by_code = fetch_oecd_cpi_by_category("PA", "GY", start, codes)
    idx_by_code = fetch_oecd_cpi_by_category("IX", "_Z", start, codes)

    categories = []
    for cat in CPI_CATEGORIES:
        yoy = yoy_by_code[cat["code"]]
        latest_month = max(yoy)
        categories.append({**cat, "yoy": yoy, "index": idx_by_code[cat["code"]]})
        print(f"    · {cat['name']:<16} {len(yoy):>3}개월  "
              f"최근 {yoy[latest_month]:+.2f}%")

    payload = {
        "fetched_at": fetched_at.isoformat(timespec="seconds"),
        "fx": fx,
        "assets": [
            {**asset, "series": raw_series[asset["id"]]}
            for asset in ASSETS
        ],
        "cpi": {"index": cpi_index, "yoy": cpi_yoy, "categories": categories},
        "cleaning_log": cleaning_log,
    }

    out = DATA_DIR / "_raw.json"
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"\n원본 저장: {out.relative_to(ROOT)}  ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
