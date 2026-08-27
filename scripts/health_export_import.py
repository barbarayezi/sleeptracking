#!/usr/bin/env python3
"""
Import an Apple Health export (export.zip / export.xml) into the app's database.

Apple Health export format: an XML document full of <Record> elements, e.g.
  <Record type="HKQuantityTypeIdentifierStepCount" unit="count"
          startDate="2026-08-01 01:00:00 +0800"
          endDate="2026-08-01 23:59:59 +0800" value="1234.5" .../>

Daily totals are computed by summing every record of a given type within a
calendar day (startDate[:10]). The file can be huge (hundreds of MB), so we
stream-parse it with iterparse instead of loading it all.

Usage:
    python health_export_import.py <path-to-export.zip | export.xml>

Idempotent: re-running replaces existing (date, type) rows (source = apple_health).
"""
import sys
import os
import zipfile
import xml.etree.ElementTree as ET

# Make project imports resolvable when run directly
# 脚本位于 scripts/ 时，需把项目根目录（上级）加入 path 才能 import health_models
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import health_models

STEP_TYPE = "HKQuantityTypeIdentifierStepCount"
ENERGY_TYPE = "HKQuantityTypeIdentifierActiveEnergyBurned"
DIST_TYPE = "HKQuantityTypeIdentifierDistanceWalkingRunning"

_METRIC_UNIT_LABEL = {
    "steps": "步",
    "active_energy_kj": "kJ",
    "distance_km": "km",
}


def _to_kj(value, unit):
    u = (unit or "").lower()
    if "kj" in u:
        return value
    return value * 4.184  # assume kcal / Cal


def _to_km(value, unit):
    u = (unit or "").lower()
    if "km" in u:
        return value
    if "mi" in u:
        return value * 1.60934
    return value


def _open_export(path):
    """Return a file-like object for export.xml (inside a zip or raw)."""
    if zipfile.is_zipfile(path):
        z = zipfile.ZipFile(path)
        name = next((n for n in z.namelist() if n.endswith("export.xml")), None)
        if not name:
            raise SystemExit(f"在 {path} 里没找到 export.xml")
        return z.open(name), z
    return open(path, "rb"), None


def parse_export(stream):
    """Stream-parse; return {(date, metric_type): total_value}."""
    totals = {}
    for event, elem in ET.iterparse(stream, events=("end",)):
        if elem.tag != "Record":
            continue
        rtype = elem.get("type")
        if rtype not in (STEP_TYPE, ENERGY_TYPE, DIST_TYPE):
            elem.clear()
            continue
        try:
            value = float(elem.get("value"))
        except (TypeError, ValueError):
            elem.clear()
            continue
        date = (elem.get("startDate") or "")[:10]
        if len(date) != 10:
            elem.clear()
            continue
        unit = elem.get("unit")
        if rtype == STEP_TYPE:
            mt, v = "steps", value
        elif rtype == ENERGY_TYPE:
            mt, v = "active_energy_kj", _to_kj(value, unit)
        else:
            mt, v = "distance_km", _to_km(value, unit)
        key = (date, mt)
        totals[key] = totals.get(key, 0.0) + v
        elem.clear()
    return totals


def main():
    if len(sys.argv) < 2:
        print("用法: python health_export_import.py <export.zip 或 export.xml 路径>")
        sys.exit(1)
    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"文件不存在: {path}")
        sys.exit(1)

    print(f"解析健康导出文件: {path}")
    stream, z = _open_export(path)
    try:
        totals = parse_export(stream)
    finally:
        stream.close()
        if z is not None:
            z.close()

    if not totals:
        print("没解析到步数 / 活动能量 / 步行距离记录（导出里可能不含这些数据）。")
        sys.exit(0)

    rows = [(d, mt, round(v, 2)) for (d, mt), v in sorted(totals.items())]
    n = health_models.bulk_upsert_health_metrics(rows, source="apple_health")

    by_type = {}
    for d, mt, v in rows:
        t = by_type.setdefault(mt, {"days": 0, "total": 0.0})
        t["days"] += 1
        t["total"] += v
    print(f"已导入 {n} 条每日指标:")
    for mt, info in by_type.items():
        label = _METRIC_UNIT_LABEL.get(mt, mt)
        print(f"  - {mt}: {info['days']} 天, 合计 {info['total']:.1f} {label}")


if __name__ == "__main__":
    main()
