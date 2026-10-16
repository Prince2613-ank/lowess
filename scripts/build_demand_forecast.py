"""SKU demand forecasts per store, for the Forecast tab.

Sales history is simulated (there is no live sales system), 90 days per SKU.
A store's daily unit sales (in store and online) are its online units from the
order history in frontend/data/metrics/stores.json - so both pages agree -
divided by the online share (ONLINE_SHARE, about 10% of units). They are spread
over the store's SKUs by popularity - stores stock roughly in line with sales,
so popularity follows the SKU's stock and reorder point, with log-normal
variation (so some products are under-stocked for their sales) - with a per-SKU drift (some
products selling more over time, some less) and a seasonal decline for lawn &
garden, then drawn as Poisson counts.

The forecast is fitted on that history, per SKU:
  * weekly pattern - the store's weekday index (weekends busier);
  * level          - exponentially weighted mean of de-seasonalised daily sales
                     (half-life 14 days);
  * trend          - slope of the last 12 weekly totals, damped and shrunk
                     towards the department's trend;
  * spread         - one-step-ahead residual standard deviation (at least the
                     Poisson spread).
Backtest: the same model fitted without the last 14 days forecasts them; the
weighted absolute percentage error (WAPE) and bias are reported with the data.

The browser combines a SKU's forecast with its *current* stock (live: picks and
edits included) to give the run-out date and the chance of running out within
7, 14 or 30 days.

Writes frontend/data/forecast/<store_id>.json.

Usage:  python scripts/build_demand_forecast.py [--stores 2383,1665]
"""
from __future__ import annotations

import argparse
import json
from datetime import date, timedelta

import numpy as np

from generate_inventory import OUTPUT_DIR as INVENTORY_DIR, ROOT

METRICS = ROOT / "frontend" / "data" / "metrics" / "stores.json"
OUTPUT_DIR = ROOT / "frontend" / "data" / "forecast"
HISTORY = 90
BACKTEST = 14
HALF_LIFE = 14
TREND_WEEKS = 12
TREND_DAMP = 0.5          # keep half of the measured trend
TREND_SHRINK = 0.35       # weight on the SKU's own trend vs its department's
TREND_LIMIT = 0.012       # per day
SEASONAL = {"Lawn & Garden": -0.005, "Outside Lawn And Garden": -0.005, "Garden Center": -0.006}
WEEKLY_SHOWN = 12
ONLINE_SHARE = 0.10       # online orders as a share of a store's unit sales
STOCK_ELASTICITY = 0.85   # popularity ~ (stock + reorder point) ^ this
POPULARITY_SPREAD = 0.75  # log-normal spread around it


def weekday_index(units: np.ndarray, days: list[date]) -> np.ndarray:
    weekday = np.array([d.weekday() for d in days])
    overall = units.mean()
    return np.array([units[weekday == k].mean() / overall if (weekday == k).any() else 1.0 for k in range(7)])


def fit(sales: np.ndarray, days: list[date], season: np.ndarray, groups: np.ndarray) -> dict:
    """Level, trend and spread per SKU from daily sales (SKUs x days)."""
    factor = season[[d.weekday() for d in days]]
    deseason = sales / factor
    alpha = 1 - 0.5 ** (1 / HALF_LIFE)
    level = deseason[:, :7].mean(axis=1)
    residuals = []
    for t in range(sales.shape[1]):
        if t >= 28:
            residuals.append(deseason[:, t] - level)
        level = level + alpha * (deseason[:, t] - level)
    residuals = np.array(residuals).T
    spread = np.sqrt(np.maximum(residuals.var(axis=1), np.maximum(level, 0.05)))
    # Trend from the last weekly totals (relative to their mean), damped and shrunk to the department's.
    weeks = min(TREND_WEEKS, sales.shape[1] // 7)
    weekly = deseason[:, -weeks * 7:].reshape(len(sales), weeks, 7).sum(axis=2)
    x = np.arange(weeks) - (weeks - 1) / 2
    mean = np.maximum(weekly.mean(axis=1), 1e-6)
    slope = (weekly * x).sum(axis=1) / (x ** 2).sum() / mean / 7          # per day, relative
    own = np.clip(slope, -0.03, 0.03)
    group_trend = np.zeros_like(own)
    for g in np.unique(groups):
        mask = groups == g
        total = weekly[mask].sum(axis=0)
        group_trend[mask] = ((total * x).sum() / (x ** 2).sum() / max(total.mean(), 1e-6) / 7)
    trend = np.clip(TREND_DAMP * (TREND_SHRINK * own + (1 - TREND_SHRINK) * group_trend), -TREND_LIMIT, TREND_LIMIT)
    return {"level": np.maximum(level, 0), "trend": trend, "spread": spread}


def forecast_totals(model: dict, start: date, horizon: int, season: np.ndarray) -> np.ndarray:
    d = np.arange(1, horizon + 1)
    factor = season[[(start + timedelta(days=int(k))).weekday() for k in d]]
    return (model["level"][:, None] * np.exp(model["trend"][:, None] * d[None, :]) * factor[None, :]).sum(axis=1)


def build(store_id: str, metrics_store: dict, end: date) -> dict | None:
    inventory_path = INVENTORY_DIR / f"{store_id}.json"
    if not inventory_path.is_file():
        return None
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    products = [(p, rack) for rack in inventory["racks"] for p in rack["products"]]
    rng = np.random.default_rng(int(store_id) * 7919 + 17)
    units = np.array(metrics_store["daily"]["units"][-HISTORY:], dtype=float) / ONLINE_SHARE
    days = [date.fromisoformat(d) for d in metrics_store["daily"]["date"][-HISTORY:]]
    season = weekday_index(units, days)

    # Simulated history: store units spread by popularity, with drift and seasonality.
    stocked = np.array([p["stock_quantity"] + p["reorder_point"] for p, _ in products], dtype=float)
    weights = np.power(np.maximum(stocked, 1.0), STOCK_ELASTICITY) * rng.lognormal(0.0, POPULARITY_SPREAD, len(products))
    weights /= weights.sum()
    seasonal = np.array([SEASONAL.get(p["product_category"] if "product_category" in p else rack["product_category"],
                                      SEASONAL.get(rack["department"], 0.0)) for p, rack in products])
    drift = np.clip(rng.normal(0.0, 0.0035, len(products)) + seasonal, -0.015, 0.015)
    t = np.arange(HISTORY) - (HISTORY - 1)
    expected = units[None, :] * weights[:, None] * np.exp(drift[:, None] * t[None, :])
    sales = rng.poisson(expected).astype(float)
    groups = np.array([rack["department"] for _, rack in products])

    # Backtest: fit without the last 14 days, forecast them.
    cut = HISTORY - BACKTEST
    held = fit(sales[:, :cut], days[:cut], weekday_index(units[:cut], days[:cut]), groups)
    predicted = forecast_totals(held, days[cut - 1], BACKTEST, season)
    actual = sales[:, cut:].sum(axis=1)
    wape = float(np.abs(predicted - actual).sum() / max(actual.sum(), 1))
    bias = float((predicted.sum() - actual.sum()) / max(actual.sum(), 1))

    model = fit(sales, days, season, groups)
    weekly = sales[:, -WEEKLY_SHOWN * 7:].reshape(len(products), WEEKLY_SHOWN, 7).sum(axis=2).astype(int)
    skus = [[p["sku"], rack["rack_id"], round(float(model["level"][i]), 3), round(float(model["trend"][i]), 5),
             round(float(model["spread"][i]), 3), weekly[i].tolist()]
            for i, (p, rack) in enumerate(products)]
    return {
        "version": 1,
        "store_id": store_id,
        "simulated": True,
        "notice": "Sales history (in store and online) is simulated; forecasts are fitted on it.",
        "online_share": ONLINE_SHARE,
        "history_end": end.isoformat(),
        "history_days": HISTORY,
        "horizons": [7, 14, 30],
        "weekday_index": [round(float(v), 4) for v in season],
        "model": {
            "method": "Weekly pattern x exponentially weighted level (14-day half-life) x damped trend",
            "backtest": {"horizon_days": BACKTEST, "wape": round(wape, 4), "bias": round(bias, 4)},
        },
        "fields": ["sku", "rack_id", "level_per_day", "trend_per_day", "spread_per_day", "weekly_sales"],
        "skus": skus,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--stores", help="Comma-separated store IDs (default: all in the metrics data)")
    args = parser.parse_args()
    wanted = set(args.stores.split(",")) if args.stores else None
    metrics = json.loads(METRICS.read_text(encoding="utf-8"))
    end = date.fromisoformat(metrics["end_date"])
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for store in metrics["stores"]:
        sid = store["store_id"]
        if wanted and sid not in wanted:
            continue
        result = build(sid, store, end)
        if result is None:
            continue
        path = OUTPUT_DIR / f"{sid}.json"
        path.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
        bt = result["model"]["backtest"]
        print(f"{sid}: {len(result['skus'])} SKUs, 14-day backtest WAPE {bt['wape']:.1%}, bias {bt['bias']:+.1%} "
              f"-> {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
