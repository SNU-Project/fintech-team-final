import unittest
from unittest import mock

from pipeline import fetch_data, transform


def month_label(number: int) -> str:
    return f"{number // 12:04d}-{number % 12 + 1:02d}"


class TransformTests(unittest.TestCase):
    def test_cagr_uses_calendar_elapsed_time(self):
        series = {"2020-01": 100.0, "2022-01": 121.0}
        self.assertAlmostEqual(transform.cagr(series), 0.10, places=12)

    def test_window_uses_calendar_cutoff_not_observation_count(self):
        series = {
            "2020-01": 80.0,
            "2022-12": 90.0,
            "2023-01": 100.0,
            "2023-06": 105.0,
            "2024-01": 110.0,
        }
        self.assertEqual(
            list(transform.window(series, 1)),
            ["2023-01", "2023-06", "2024-01"],
        )

    def test_volatility_ignores_nonconsecutive_gap_return(self):
        start = transform.month_number("2020-01")
        series = {
            month_label(start + offset): 100 * (1.01 ** offset)
            for offset in range(15)
            if offset != 6
        }
        # 연속 관측쌍은 모두 +1%다. 빠진 달을 건너뛴 +2.01%를 한 달
        # 수익률로 잘못 넣지 않으므로 변동성은 사실상 0이어야 한다.
        self.assertAlmostEqual(transform.annual_volatility(series), 0.0, places=12)

    def test_portfolio_volatility_uses_common_monthly_returns(self):
        start = transform.month_number("2020-01")
        first, second = 100.0, 100.0
        series_a = {month_label(start): first}
        series_b = {month_label(start): second}
        for offset in range(1, 13):
            return_a = 0.10 if offset % 2 else -0.10
            first *= 1 + return_a
            second *= 1 - return_a
            series_a[month_label(start + offset)] = first
            series_b[month_label(start + offset)] = second

        returns = transform.portfolio_monthly_returns(
            {"a": series_a, "b": series_b}, {"a": 0.5, "b": 0.5}
        )
        self.assertEqual(len(returns), 12)
        self.assertAlmostEqual(transform.annualized_volatility(returns), 0.0, places=12)


class DailyFallbackTests(unittest.TestCase):
    def test_restore_only_fills_missing_month_and_never_overwrites_monthly(self):
        monthly = {"2020-01": 100.0, "2020-03": 120.0}
        daily_month_ends = {"2020-01": 999.0, "2020-02": 110.0, "2020-03": 999.0}
        with mock.patch.object(
            fetch_data, "fetch_daily_month_ends", return_value=daily_month_ends
        ):
            restored, filled, unresolved = fetch_data.restore_missing_months("TEST", monthly)

        self.assertEqual(restored["2020-01"], 100.0)
        self.assertEqual(restored["2020-02"], 110.0)
        self.assertEqual(restored["2020-03"], 120.0)
        self.assertEqual(filled, ["2020-02"])
        self.assertEqual(unresolved, [])

    def test_unresolved_month_is_not_invented(self):
        monthly = {"2020-01": 100.0, "2020-03": 120.0}
        with mock.patch.object(fetch_data, "fetch_daily_month_ends", return_value={}):
            restored, filled, unresolved = fetch_data.restore_missing_months("TEST", monthly)

        self.assertNotIn("2020-02", restored)
        self.assertEqual(filled, [])
        self.assertEqual(unresolved, ["2020-02"])


if __name__ == "__main__":
    unittest.main()
