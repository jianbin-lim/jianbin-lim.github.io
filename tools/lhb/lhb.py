#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lhb.py — 东方财富龙虎榜「游资标签」本地复盘页生成器

只依赖 Python 标准库。数据来自东方财富公开接口：
  RPT_DAILYBILLBOARD_DETAILSNEW   当日龙虎榜个股
  RPT_BILLBOARD_DAILYDETAILSBUY   当日买入前五席位
  RPT_BILLBOARD_DAILYDETAILSSELL  当日卖出前五席位

用法:
  python lhb.py                      # 最近一个有数据的交易日
  python lhb.py --date 2026-10-30    # 指定日期
  python lhb.py --open               # 生成后用默认浏览器打开
  python lhb.py --no-cache           # 忽略本地缓存，强制重新抓取

产出:
  output/lhb-YYYY-MM-DD.html        深色复盘页（左侧个股、右侧买五卖五、游资榜）
  output/lhb-YYYY-MM-DD-seats.csv   全部席位明细（可用 Excel / 通达信自定义数据再加工）
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timedelta

BASE = "https://datacenter-web.eastmoney.com/api/data/v1/get"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(ROOT, "cache")
OUT_DIR = os.path.join(ROOT, "output")

BOARD_ORDER = ["沪主板", "深主板", "创业板", "科创板", "北交所", "可转债", "ETF/基金", "其他"]

# 交易所对部分榜单只披露投资者分类，这些"席位"不是营业部
CATEGORY_NAMES = {
    "自然人", "机构投资者", "中小投资者", "其他自然人", "深股通投资者",
    "沪股通投资者", "企业法人", "其他投资者", "专业机构投资者",
}

# --------------------------------------------------------------------------- #
# 接口
# --------------------------------------------------------------------------- #


def _request(params: dict) -> dict:
    url = BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Referer": "https://data.eastmoney.com/"}
    )
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(f"接口请求失败: {last}")


def api(report: str, trade_date: str, page_size: int = 5000) -> list[dict]:
    """拉取某个 report 在指定交易日的全部行（自动翻页）。"""
    rows: list[dict] = []
    page = 1
    while True:
        data = _request(
            {
                "reportName": report,
                "columns": "ALL",
                "filter": f"(TRADE_DATE='{trade_date}')",
                "pageNumber": str(page),
                "pageSize": str(page_size),
                "source": "WEB",
                "client": "WEB",
            }
        )
        if not data.get("success"):
            message = data.get("message") or ""
            # 非交易日 / 当日数据还没出，接口会返回「返回数据为空」
            if "为空" in message:
                return rows
            raise RuntimeError(f"{report} 返回失败: {message}")
        result = data.get("result") or {}
        rows.extend(result.get("data") or [])
        pages = int(result.get("pages") or 1)
        if page >= pages:
            return rows
        page += 1


def cached(report: str, trade_date: str, use_cache: bool) -> list[dict]:
    if not use_cache:
        return api(report, trade_date)
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f"{trade_date}_{report}.json")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:  # noqa: BLE001
            pass
    rows = api(report, trade_date)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, ensure_ascii=False)
    return rows


# --------------------------------------------------------------------------- #
# 工具函数
# --------------------------------------------------------------------------- #


def board_of(code: str, market: str = "") -> str:
    c = (code or "").strip()
    if c.startswith(("11", "12", "13")):
        return "可转债"
    if c.startswith(("92", "43", "83", "87", "88", "82", "89")):
        return "北交所"
    if c.startswith("68"):
        return "科创板"
    if c.startswith("30"):
        return "创业板"
    if c.startswith(("60", "601", "603", "605")):
        return "沪主板"
    if c.startswith(("00", "001", "002", "003")):
        return "深主板"
    if c.startswith(("15", "16", "50", "51", "52", "56", "58")):
        return "ETF/基金"
    if "创业板" in (market or ""):
        return "创业板"
    if "科创板" in (market or ""):
        return "科创板"
    if "北" in (market or ""):
        return "北交所"
    if "上海" in (market or ""):
        return "沪主板"
    if "深圳" in (market or ""):
        return "深主板"
    return "其他"


def fmt_amount(value) -> str:
    if value is None:
        return "-"
    try:
        v = float(value)
    except (TypeError, ValueError):
        return "-"
    sign = "+" if v > 0 else ("-" if v < 0 else "")
    a = abs(v)
    if a >= 1e8:
        return f"{sign}{a / 1e8:.2f}亿"
    if a >= 1e4:
        return f"{sign}{a / 1e4:.0f}万"
    return f"{sign}{a:.0f}"


def canon_name(text: str) -> str:
    """券商改名对齐：国泰君安 / 海通 → 国泰海通，安信 → 国投，新时代 → 诚通。"""
    text = text.replace("国泰君安证券", "国泰海通证券")
    text = re.sub(r"(?<!国泰)海通证券", "国泰海通证券", text)
    text = text.replace("安信证券", "国投证券")
    text = text.replace("新时代证券", "诚通证券")
    text = text.replace("中投证券", "中金财富证券")
    return text


def norm_name(text: str) -> str:
    """营业部名规范化：去掉「证券/股份有限公司/营业部」等噪声，便于跨写法比对。"""
    s = canon_name(text)
    s = re.sub(r"[（）()\[\]【】\s\u3000·]", "", s)
    for token in (
        "股份有限公司",
        "有限责任公司",
        "有限公司",
        "非营业场所",
        "证券营业部",
        "营业部",
        "证券",
    ):
        s = s.replace(token, "")
    return re.sub(r"(专用)\d+$", r"\1", s)


def load_tags(path: str) -> list[dict]:
    """读取标签库：关键词,标签,类型,备注（# 开头为注释）。"""
    rules: list[dict] = []
    if not os.path.exists(path):
        return rules
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.reader(fh):
            if not row or not row[0].strip() or row[0].lstrip().startswith("#"):
                continue
            keyword = row[0].strip()
            tag = row[1].strip() if len(row) > 1 else ""
            kind = row[2].strip() if len(row) > 2 else "游资"
            note = row[3].strip() if len(row) > 3 else ""
            if not (keyword and tag):
                continue
            # 看起来是营业部全名的走规范化比对，只写片段的走子串匹配
            full = any(k in keyword for k in ("证券", "营业部", "分公司"))
            rules.append(
                {
                    "kw": keyword,
                    "tag": tag,
                    "kind": kind or "游资",
                    "note": note,
                    "full": full,
                    "norm": norm_name(keyword) if full else keyword,
                }
            )
    # 越具体的规则越先命中
    rules.sort(key=lambda r: len(r["norm"]), reverse=True)
    return rules


def tags_for(seat_name: str, rules: list[dict]) -> list[dict]:
    seat_norm = norm_name(seat_name)
    hits: list[dict] = []
    for rule in rules:
        if rule["full"]:
            rn = rule["norm"]
            hit = seat_norm == rn or (
                len(rn) >= 8 and (seat_norm.startswith(rn) or rn.startswith(seat_norm))
            )
        else:
            hit = rule["kw"] in seat_name
        if hit and rule["tag"] not in [h["tag"] for h in hits]:
            hits.append(rule)
        if len(hits) >= 3:
            break
    return hits


def trading_dates_back(start: datetime, limit: int = 12) -> list[str]:
    out = []
    day = start
    while len(out) < limit:
        if day.weekday() < 5:
            out.append(day.strftime("%Y-%m-%d"))
        day -= timedelta(days=1)
    return out


def find_latest_date(use_cache: bool) -> str:
    for date in trading_dates_back(datetime.now(), 12):
        path = os.path.join(CACHE_DIR, f"{date}_RPT_DAILYBILLBOARD_DETAILSNEW.json")
        if use_cache and os.path.exists(path):
            return date
        try:
            rows = api("RPT_DAILYBILLBOARD_DETAILSNEW", date)
        except Exception:  # noqa: BLE001
            continue
        if rows:
            return date
    raise RuntimeError("最近 12 个交易日都没有取到龙虎榜数据")


# --------------------------------------------------------------------------- #
# 组装数据
# --------------------------------------------------------------------------- #


def build(date: str, rules: list[dict], use_cache: bool, live: bool = True) -> dict:
    day_rows = cached("RPT_DAILYBILLBOARD_DETAILSNEW", date, use_cache)
    if not day_rows:
        raise RuntimeError(f"{date} 没有龙虎榜数据（非交易日或数据未更新）")
    buy_rows = cached("RPT_BILLBOARD_DAILYDETAILSBUY", date, use_cache)
    sell_rows = cached("RPT_BILLBOARD_DAILYDETAILSSELL", date, use_cache)

    # 按 (代码, 榜单类型) 归组席位
    buy_map: dict[tuple, list] = {}
    for row in buy_rows:
        buy_map.setdefault((row["SECURITY_CODE"], row["CHANGE_TYPE"]), []).append(row)
    sell_map: dict[tuple, list] = {}
    for row in sell_rows:
        sell_map.setdefault((row["SECURITY_CODE"], row["CHANGE_TYPE"]), []).append(row)

    # 同一只股票可能上多个榜，按成交额挑主榜，理由合并展示
    by_code: dict[str, list] = {}
    for row in day_rows:
        by_code.setdefault(row["SECURITY_CODE"], []).append(row)

    stocks = []
    for code, rows in by_code.items():
        # 优先取「日」榜单（日涨幅/日换手/日振幅），避免把「连续 N 日累计」的
        # 金额当成当日金额；只有连续榜时再按成交额取最大的。
        def rank_key(r: dict) -> tuple:
            expl = r.get("EXPLANATION") or ""
            return (
                1 if "连续" in expl else 0,
                -(
                    float(r.get("BILLBOARD_BUY_AMT") or 0)
                    + float(r.get("BILLBOARD_SELL_AMT") or 0)
                ),
            )

        primary = min(rows, key=rank_key)
        ct = primary["CHANGE_TYPE"]
        reasons = []
        for r in rows:
            text = (r.get("EXPLANATION") or "").strip()
            if text and text not in reasons:
                reasons.append(text)

        buys = sorted(
            buy_map.get((code, ct), []), key=lambda r: float(r.get("BUY") or 0), reverse=True
        )[:5]
        sells = sorted(
            sell_map.get((code, ct), []), key=lambda r: float(r.get("SELL") or 0), reverse=True
        )[:5]

        # 同一席位同时出现在买卖两侧时，标注「买1·卖3」
        buy_rank, sell_rank = {}, {}
        for i, seat in enumerate(buys, 1):
            buy_rank.setdefault(seat["OPERATEDEPT_NAME"], i)
        for i, seat in enumerate(sells, 1):
            sell_rank.setdefault(seat["OPERATEDEPT_NAME"], i)

        def pack(seat: dict, rank: int, side: str) -> dict:
            name = seat["OPERATEDEPT_NAME"]
            pos = []
            if name in buy_rank:
                pos.append(f"买{buy_rank[name]}")
            if name in sell_rank:
                pos.append(f"卖{sell_rank[name]}")
            return {
                "rank": rank,
                "name": name,
                "buy": float(seat.get("BUY") or 0),
                "sell": float(seat.get("SELL") or 0),
                "net": float(seat.get("NET") or 0),
                "pos": "·".join(pos),
                "tags": tags_for(name, rules),
                "side": side,
            }

        buy_seats = [pack(s, i, "buy") for i, s in enumerate(buys, 1)]
        sell_seats = [pack(s, i, "sell") for i, s in enumerate(sells, 1)]

        # 有些榜单（退市整理、无涨跌幅限制等）交易所只披露「自然人 / 机构投资者 /
        # 中小投资者」这类分类，不是营业部，金额也不可当席位净额看。
        category_only = any(
            s["name"] in CATEGORY_NAMES for s in buy_seats + sell_seats
        )

        # 合计口径与东财一致：把「买五 + 卖五」共十席合并、同名席位只算一次，
        # 再分别对买入额、卖出额求和。所以总计 ≥ 单侧五席合计（卖五席位可能也买入）。
        if category_only or not (buy_seats or sell_seats):
            buy_total = float(primary.get("BILLBOARD_BUY_AMT") or 0)
            sell_total = float(primary.get("BILLBOARD_SELL_AMT") or 0)
            net = float(primary.get("BILLBOARD_NET_AMT") or 0)
        else:
            unique: dict[tuple, dict] = {}
            for seat in buy_seats + sell_seats:
                # 同名不代表同一席位（「机构专用」每次上榜都是一条独立记录），
                # 所以用「名称 + 买入额 + 卖出额」做键，只去掉买卖两表重复的那一条。
                unique.setdefault(
                    (seat["name"], seat["buy"], seat["sell"]),
                    {"buy": seat["buy"], "sell": seat["sell"]},
                )
            buy_total = sum(v["buy"] for v in unique.values())
            sell_total = sum(v["sell"] for v in unique.values())
            net = buy_total - sell_total

        stock = {
            "code": code,
            "name": primary.get("SECURITY_NAME_ABBR") or code,
            "board": board_of(code, primary.get("TRADE_MARKET") or ""),
            "pct": float(primary.get("CHANGE_RATE") or 0),
            "close": float(primary.get("CLOSE_PRICE") or 0),
            "turnover": float(primary.get("TURNOVERRATE") or 0),
            "buy_total": buy_total,
            "sell_total": sell_total,
            "net": net,
            "category_only": category_only,
            "reasons": reasons,
            "buy_seats": buy_seats,
            "sell_seats": sell_seats,
        }
        stocks.append(stock)

    stocks.sort(
        key=lambda s: (
            BOARD_ORDER.index(s["board"]) if s["board"] in BOARD_ORDER else 99,
            -s["net"],
        )
    )

    total_net = sum(s["net"] for s in stocks)
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    if not live or date == today:
        # 指定日期的历史复盘页，不弹「今日数据未出」
        stale, hint = False, ""
    elif now.weekday() >= 5:
        stale, hint = True, "今日休市"
    else:
        stale, hint = True, f"{today} 数据未出（交易日 16:30 后更新）"
    return {
        "date": date,
        "today": today,
        "stale": stale,
        "hint": hint,
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "stocks": stocks,
        "stats": {
            "count": len(stocks),
            "net": total_net,
            "tagged": sum(
                1
                for s in stocks
                for seat in s["buy_seats"] + s["sell_seats"]
                if seat["tags"]
            ),
        },
    }


# --------------------------------------------------------------------------- #
# 输出
# --------------------------------------------------------------------------- #


def write_csv(payload: dict, path: str) -> None:
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            ["日期", "代码", "名称", "板块", "涨跌幅", "方向", "序号",
             "营业部", "游资标签", "买入", "卖出", "净额", "同席位位置"]
        )
        for stock in payload["stocks"]:
            for side, key in (("买入", "buy_seats"), ("卖出", "sell_seats")):
                for seat in stock[key]:
                    writer.writerow(
                        [
                            payload["date"], stock["code"], stock["name"], stock["board"],
                            f"{stock['pct']:.2f}%", side, seat["rank"], seat["name"],
                            "/".join(t["tag"] for t in seat["tags"]),
                            f"{seat['buy']:.2f}", f"{seat['sell']:.2f}", f"{seat['net']:.2f}",
                            seat["pos"],
                        ]
                    )


def payload_hash(payload: dict) -> str:
    """内容指纹（不含生成时间），用来判断数据有没有真的变。"""
    body = {k: v for k, v in payload.items() if k != "generated"}
    return hashlib.sha1(
        json.dumps(body, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]


def write_html(payload: dict, path: str, backlink: str = "") -> None:
    data = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    stats = payload["stats"]
    html = TEMPLATE.replace("__DATE__", payload["date"])
    html = html.replace("__GENERATED__", payload["generated"])
    html = html.replace("__BACKLINK__", backlink)
    html = html.replace(
        "__STATS__",
        f"上榜 <b>{stats['count']}</b> 只 · 净额 <b class=\"{'up' if stats['net'] >= 0 else 'down'}\">"
        f"{fmt_amount(stats['net'])}</b> · 带标签席位 <b>{stats['tagged']}</b>",
    )
    html = html.replace("__DATA__", data)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(html)


def _read_version_hash(directory: str) -> str | None:
    path = os.path.join(directory, "version.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return (json.load(fh) or {}).get("hash")
    except Exception:  # noqa: BLE001
        return None


def write_version(payload: dict, directory: str, html_name: str = "index.html") -> dict:
    """给页面轮询用的版本文件，静态站（GitHub Pages）和本地服务共用。"""
    version = {
        "hash": payload_hash(payload),
        "date": payload["date"],
        "html": html_name,
        "generated": payload["generated"],
        "stocks": len(payload["stocks"]),
        "net": payload["stats"]["net"],
        "stale": payload["stale"],
    }
    os.makedirs(directory, exist_ok=True)
    tmp = os.path.join(directory, "version.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(version, fh, ensure_ascii=False)
    os.replace(tmp, os.path.join(directory, "version.json"))
    return version


TEMPLATE = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>龙虎榜复盘 __DATE__</title>
<style>
:root{
  --bg:#0a0c10; --panel:#111420; --panel2:#161a26; --line:#232838;
  --txt:#dbe1ea; --dim:#8590a3; --up:#ff5b4a; --down:#22c55e;
  --gold:#e5a94b; --purple:#a78bfa; --blue:#5aa9ff; --cyan:#35c9b6; --gray:#94a3b8;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--txt);
  font:13px/1.55 "Microsoft YaHei","PingFang SC",-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.top{display:flex;align-items:center;gap:16px;padding:10px 16px;background:var(--panel);
  border-bottom:1px solid var(--line);position:sticky;top:0;z-index:9;flex-wrap:wrap}
.brand{font-size:15px;font-weight:700;letter-spacing:.5px}
.brand .date{color:var(--gold);margin-left:8px;font-weight:600}
.brand .sub{color:var(--dim);font-size:11px;font-weight:400;margin-left:10px}
.stat{color:var(--dim);font-size:12px}
.stat b{color:var(--txt);font-weight:600}
.tabs{display:flex;gap:4px;margin-left:auto}
.tabs button{padding:5px 14px;border-radius:6px;color:var(--dim);border:1px solid transparent}
.tabs button.on{color:var(--gold);background:#1b1f2e;border-color:#2b3247}
#q{width:260px;padding:6px 10px;border-radius:6px;border:1px solid var(--line);
  background:#0d1017;color:var(--txt);outline:none}
#q:focus{border-color:#3a4460}
.wrap{display:flex;height:calc(100vh - 49px);overflow:hidden}
aside{width:330px;min-width:330px;border-right:1px solid var(--line);overflow:auto;background:#0c0f16}
.grp{position:sticky;top:0;background:#0c0f16;padding:7px 12px;color:var(--gold);
  font-size:11px;letter-spacing:1px;border-bottom:1px solid #1a1f2c;z-index:2}
.grp span{color:var(--dim);letter-spacing:0}
.item{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid #161a24;
  cursor:pointer;width:100%;text-align:left}
.item:hover{background:#141926}
.item.on{background:#1a2030;box-shadow:inset 3px 0 0 var(--gold)}
.item .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item .cd{color:var(--dim);font-size:11px;font-variant-numeric:tabular-nums}
.item .pct,.item .net{font-variant-numeric:tabular-nums;font-size:12px;min-width:62px;text-align:right}
main{flex:1;overflow:auto;padding:16px 20px 60px}
.up{color:var(--up)} .down{color:var(--down)} .dim{color:var(--dim)}
h1.h{font-size:20px;margin:0 0 2px;display:flex;align-items:baseline;gap:10px}
h1.h .code{font-size:12px;color:var(--dim);font-weight:400}
.meta{color:var(--dim);font-size:12px;margin-bottom:14px}
.cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:9px 14px;min-width:120px}
.card .k{color:var(--dim);font-size:11px;margin-bottom:2px}
.card .v{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
.reason{background:#12151f;border-left:3px solid var(--gold);padding:7px 12px;
  color:#c6cede;font-size:12px;margin-bottom:16px;border-radius:0 6px 6px 0}
h2.sec{font-size:13px;color:var(--gold);margin:18px 0 8px;letter-spacing:1px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{font-weight:500;color:var(--dim);font-size:12px;text-align:right;padding:7px 10px;
  border-bottom:1px solid var(--line);background:#0f1320;position:sticky;top:0}
th.l,td.l{text-align:left}
td{padding:7px 10px;border-bottom:1px solid #191e2b;text-align:right}
tr:hover td{background:#121724}
td.num{font-variant-numeric:tabular-nums}
tfoot td{border-top:1px solid var(--line);font-weight:700;background:#10141f}
.pill{display:inline-block;padding:0 6px;margin-left:5px;border-radius:4px;font-size:11px;
  line-height:17px;border:1px solid;vertical-align:1px;white-space:nowrap}
.ty游资{color:#ffb4a8;border-color:#7a3a34;background:#2a1512}
.ty帮派{color:#c8b6ff;border-color:#4a3d7a;background:#1b1730}
.ty资金{color:#9fc9ff;border-color:#2f4a72;background:#101b2c}
.ty机构{color:#8fe0d4;border-color:#245c55;background:#0d1f1d}
.ty席位{color:#aab4c5;border-color:#3a4356;background:#171b25}
.pos{color:#8b94a3;border-color:#39415a;background:#141827;font-variant-numeric:tabular-nums}
.youliao td{text-align:right} .youliao td.l{text-align:left}
.empty{color:var(--dim);padding:40px 0;text-align:center}
.flt{display:inline-flex;align-items:center;gap:6px;color:var(--dim);font-size:12px;
  margin:-2px 0 10px;cursor:pointer;user-select:none}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--down);
  margin-right:5px;vertical-align:1px;animation:bp 1.8s infinite}
@keyframes bp{0%,100%{opacity:1}50%{opacity:.25}}
.stale{color:#ffb86b;border:1px solid #6b4a1f;background:#241a0d;padding:1px 8px;
  border-radius:4px;font-size:11px}
.backlink{color:var(--dim);text-decoration:none;font-weight:400;font-size:12px;
  margin-right:10px;border-bottom:1px dashed #3a4152;padding-bottom:1px}
.backlink:hover{color:var(--gold);border-color:var(--gold)}
.flt input{accent-color:var(--gold)}
a.jump{color:var(--blue);cursor:pointer}
</style>
</head>
<body>
<div class="top">
  <div class="brand">__BACKLINK__龙虎榜 · 游资复盘 <span class="date">__DATE__</span>
    <span class="sub">生成于 __GENERATED__ · 数据源：东方财富公开接口</span></div>
  <div class="stat">__STATS__</div>
  <span id="live"></span>
  <div class="tabs">
    <button data-view="stocks" class="on">个股</button>
    <button data-view="youliao">游资榜</button>
  </div>
  <input id="q" placeholder="搜 股票 / 代码 / 游资 / 营业部">
</div>
<div class="wrap">
  <aside id="side"></aside>
  <main id="main"></main>
</div>
<script>
const DATA = __DATA__;
const BOARDS = ["沪主板","深主板","创业板","科创板","北交所","可转债","ETF/基金","其他"];
const S = DATA.stocks;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmt = (v) => {
  if (v == null || isNaN(v)) return "-";
  const sign = v > 0 ? "+" : (v < 0 ? "-" : "");
  const a = Math.abs(v);
  if (a >= 1e8) return sign + (a/1e8).toFixed(2) + "亿";
  if (a >= 1e4) return sign + (a/1e4).toFixed(0) + "万";
  return sign + a.toFixed(0);
};
const fmtPct = (v) => (v > 0 ? "+" : "") + v.toFixed(2) + "%";
const cls = (v) => v > 0 ? "up" : (v < 0 ? "down" : "dim");
// 自动刷新时保留你正在看的股票 / 标签页
const store = {
  get(k, d){ try { const v = sessionStorage.getItem(k); return v == null ? d : v; } catch(e){ return d; } },
  set(k, v){ try { sessionStorage.setItem(k, v); } catch(e){} }
};
let current = store.get("lhb.code", null);
let view = store.get("lhb.view", "stocks");
let keyword = "";
let hideInst = true;

function pills(seat){
  let out = (seat.tags || []).map(t => `<span class="pill ty${esc(t.kind)}" title="${esc(t.note||'')}">${esc(t.tag)}</span>`).join("");
  if (seat.pos) out += `<span class="pill pos">${esc(seat.pos)}</span>`;
  return out;
}

function renderList(){
  const kw = keyword.trim().toLowerCase();
  const groups = {};
  S.forEach(s => {
    if (kw){
      const hit = (s.name + s.code).toLowerCase().includes(kw)
        || (s.buy_seats.concat(s.sell_seats).some(x => x.name.toLowerCase().includes(kw) || (x.tags||[]).some(t => t.tag.toLowerCase().includes(kw))));
      if (!hit) return;
    }
    (groups[s.board] = groups[s.board] || []).push(s);
  });
  const side = $("#side");
  if (!Object.keys(groups).length){ side.innerHTML = `<div class="empty">没有匹配的股票</div>`; return; }
  let html = "";
  BOARDS.forEach(b => {
    const arr = groups[b];
    if (!arr) return;
    html += `<div class="grp">${b} <span>${arr.length}</span></div>`;
    arr.forEach(s => {
      html += `<button class="item ${current===s.code?"on":""}" data-code="${s.code}">
        <span class="nm">${esc(s.name)}</span>
        <span class="cd">${esc(s.code)}</span>
        <span class="pct ${cls(s.pct)}">${fmtPct(s.pct)}</span>
        <span class="net ${cls(s.net)}">${fmt(s.net)}</span>
      </button>`;
    });
  });
  side.innerHTML = html;
  side.querySelectorAll(".item").forEach(el => el.onclick = () => {
    const keep = side.scrollTop;
    current = el.dataset.code;
    store.set("lhb.code", current);
    renderList();
    side.scrollTop = keep;
    renderDetail();
  });
}

function seatTable(seats, side){
  if (!seats.length) return `<div class="empty">该榜单没有披露营业部明细</div>`;
  let buy=0, sell=0, net=0;
  seats.forEach(s => { buy += s.buy; sell += s.sell; net += s.net; });
  const rows = seats.map(s => `<tr>
      <td class="dim">${s.rank}</td>
      <td class="l">${esc(s.name)}${pills(s)}</td>
      <td class="num">${fmt(s.buy)}</td>
      <td class="num">${fmt(s.sell)}</td>
      <td class="num ${cls(s.net)}">${fmt(s.net)}</td>
    </tr>`).join("");
  return `<table>
    <thead><tr><th style="width:44px">序号</th><th class="l">营业部名称</th>
      <th style="width:110px">买入</th><th style="width:110px">卖出</th><th style="width:110px">净额</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td></td><td class="l">本表五席合计</td>
      <td class="num">${fmt(buy)}</td><td class="num">${fmt(sell)}</td>
      <td class="num ${cls(net)}">${fmt(net)}</td></tr></tfoot>
  </table>`;
}

function renderDetail(){
  const main = $("#main");
  if (view === "youliao"){ renderYouliao(); return; }
  const s = S.find(x => x.code === current) || S[0];
  if (!s){ main.innerHTML = `<div class="empty">没有数据</div>`; return; }
  current = s.code;
  main.innerHTML = `
    <h1 class="h">${esc(s.name)} <span class="code">${esc(s.code)} · ${esc(s.board)}</span>
      <span class="${cls(s.pct)}" style="font-size:16px">${fmtPct(s.pct)}</span></h1>
    <div class="meta">收盘 ${s.close.toFixed(2)} · 换手 ${s.turnover.toFixed(2)}% · 上榜理由见下</div>
    <div class="cards">
      <div class="card"><div class="k">龙虎榜净买</div><div class="v ${cls(s.net)}">${fmt(s.net)}</div></div>
      <div class="card"><div class="k">买入总计</div><div class="v up">${fmt(s.buy_total)}</div></div>
      <div class="card"><div class="k">卖出总计</div><div class="v down">${fmt(s.sell_total)}</div></div>
      <div class="card"><div class="k">净额 / 成交</div><div class="v ${cls(s.net)}">${(s.net/ (s.buy_total+s.sell_total||1) *100).toFixed(1)}%</div></div>
    </div>
    <div class="meta" style="margin:-6px 0 12px">总计与净额为「买卖十席合并去重」口径：卖五席位的买入额也计入买入总计，所以不等于单张表的五席合计（与东财、多数龙虎榜软件一致）。</div>
    <div class="reason">${s.reasons.map(esc).join("<br>") || "—"}</div>
    ${s.category_only ? `<div class="reason" style="border-left-color:#ff9f43">该榜单交易所只披露「投资者分类」，不含营业部席位；合计与净额取东方财富汇总口径，不能按游资席位解读。</div>` : ""}
    <h2 class="sec">买入营业部</h2>
    ${seatTable(s.buy_seats, "buy")}
    <h2 class="sec">卖出营业部</h2>
    ${seatTable(s.sell_seats, "sell")}
  `;
}

function renderYouliao(){
  const agg = new Map();
  S.forEach(s => {
    const seen = new Set();
    s.buy_seats.concat(s.sell_seats).forEach(seat => {
      (seat.tags || []).forEach(t => {
        const key = t.tag;
        if (!agg.has(key)) agg.set(key, {tag:key, kind:t.kind, net:0, buy:0, sell:0, stocks:new Map()});
        const a = agg.get(key);
        if (seen.has(key + "@" + seat.name)) return;
        seen.add(key + "@" + seat.name);
        a.net += seat.net; a.buy += seat.buy; a.sell += seat.sell;
        a.stocks.set(s.code, s.name);
      });
    });
  });
  const all = [...agg.values()].sort((x,y) => y.net - x.net);
  const list = all.filter(a => !hideInst || a.kind !== "机构");
  const main = $("#main");
  if (!all.length){
    main.innerHTML = `<div class="empty">标签库还没有命中任何席位，去 tags.csv 里加几条「营业部关键词,标签」再重跑。</div>`;
    return;
  }
  const rows = list.map(a => `<tr>
      <td class="l"><span class="pill ty${esc(a.kind)}">${esc(a.tag)}</span></td>
      <td class="l dim">${[...a.stocks.values()].map(esc).join("、")}</td>
      <td class="num ${cls(a.net)}">${fmt(a.net)}</td>
      <td class="num">${fmt(a.buy)}</td>
      <td class="num">${fmt(a.sell)}</td>
      <td class="num">${a.stocks.size}</td>
    </tr>`).join("");
  main.innerHTML = `<h2 class="sec">游资 / 席位 标签榜（按净额排序）</h2>
    <label class="flt"><input type="checkbox" id="hideInst" ${hideInst?"checked":""}>
      隐藏机构 / 北向（${all.length - all.filter(a=>a.kind!=="机构").length} 条）</label>
    <table class="youliao"><thead><tr><th class="l" style="width:180px">标签</th>
      <th class="l">涉及个股</th><th style="width:110px">净额</th>
      <th style="width:110px">买入</th><th style="width:110px">卖出</th><th style="width:70px">只数</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <div class="meta" style="margin-top:12px">净额 = 该标签下所有上榜席位当日净额之和（同一席位在买五、卖五各出现一次只算一次）。标签来自 tags.csv，社区口径，仅供参考。</div>`;
  const cb = $("#hideInst");
  if (cb) cb.onchange = (e) => { hideInst = e.target.checked; renderYouliao(); };
}

function render(){
  if (!current && S.length) current = S[0].code;
  if (view === "stocks"){ renderList(); renderDetail(); }
  else { renderList(); renderYouliao(); }
}

document.querySelectorAll(".tabs button").forEach(btn => {
  btn.classList.toggle("on", btn.dataset.view === view);
  btn.onclick = () => {
    view = btn.dataset.view;
    store.set("lhb.view", view);
    document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b === btn));
    render();
  };
});
$("#q").addEventListener("input", e => { keyword = e.target.value; renderList(); });

// 顶部状态：是否已经是最新交易日 / 是否在用 HTTP 服务（可自动刷新）
const isHttp = (typeof location !== "undefined") && location.protocol.indexOf("http") === 0;
(function(){
  const live = $("#live");
  if (!live) return;
  if (DATA.stale){
    live.innerHTML = `<span class="stale" title="龙虎榜在交易日 16:30–17:00 之后更新">${esc(DATA.hint || (DATA.today + " 数据未出"))}，当前为 ${esc(DATA.date)}</span>`;
  } else if (isHttp){
    live.innerHTML = `<span class="dim" style="font-size:12px"><span class="dot"></span>自动刷新中</span>`;
  }
})();

// 有新数据就整页刷新（浏览器记住当前选中项，不会跳走）
let __ver = null;
async function pollVersion(){
  try{
    // 本地服务 / GitHub Pages 都在同一目录放 version.json
    const resp = await fetch("version.json", { cache: "no-store" });
    if (!resp.ok) return;
    const v = await resp.json();
    if (__ver !== null && String(v.hash) !== __ver) { location.reload(); return; }
    __ver = String(v.hash);
  } catch(e){ /* 直接双击打开的 file:// 页面没有这个文件，忽略 */ }
}
if (isHttp){
  pollVersion();
  setInterval(pollVersion, 60000);
}

render();
</script>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser(description="生成东方财富龙虎榜游资标签复盘页")
    parser.add_argument("--date", help="交易日，如 2026-10-30；缺省取最近有数据的一天")
    parser.add_argument("--tags", default=os.path.join(ROOT, "tags.csv"), help="标签库 CSV 路径")
    parser.add_argument("--out", default=OUT_DIR, help="输出目录")
    parser.add_argument("--open", action="store_true", help="生成后用浏览器打开")
    parser.add_argument("--no-cache", action="store_true", help="不读本地缓存")
    parser.add_argument(
        "--static", metavar="DIR", help="静态站模式：往 DIR 写 index.html + version.json"
    )
    parser.add_argument("--site-link", default="", help="静态站左上角的返回链接，如 https://example.com/")
    args = parser.parse_args(argv)

    use_cache = not args.no_cache
    rules = load_tags(args.tags)
    print(f"标签库：{args.tags}（{len(rules)} 条规则）")

    date = args.date or find_latest_date(use_cache)
    print(f"交易日：{date}")
    try:
        payload = build(date, rules, use_cache, live=(args.date is None))
    except RuntimeError as exc:
        print(f"错误：{exc}")
        return 2

    backlink = ""
    if args.site_link:
        backlink = (
            f'<a class="backlink" href="{args.site_link}" '
            f'aria-label="返回主站">← 返回主站</a>'
        )

    # 静态站模式（GitHub Pages）：目录下只放 index.html + version.json
    if args.static:
        digest = payload_hash(payload)
        html_path = os.path.join(args.static, "index.html")
        if (
            os.path.exists(html_path)
            and _read_version_hash(args.static) == digest
        ):
            # 数据没变就不重写，避免「生成时间」变化产生无意义的提交
            print(f"无变化（版本 {digest}），跳过写入")
            return 0

        os.makedirs(args.static, exist_ok=True)
        write_html(payload, html_path, backlink)
        version = write_version(payload, args.static, "index.html")
        print(
            f"完成：{len(payload['stocks'])} 只上榜，"
            f"净额 {fmt_amount(payload['stats']['net'])}，版本 {version['hash']}"
        )
        print(f"  {html_path}")
        print(f"  {os.path.join(args.static, 'version.json')}")
        return 0

    os.makedirs(args.out, exist_ok=True)
    html_path = os.path.join(args.out, f"lhb-{date}.html")
    csv_path = os.path.join(args.out, f"lhb-{date}-seats.csv")
    write_html(payload, html_path, backlink)
    write_csv(payload, csv_path)
    write_version(payload, args.out, os.path.basename(html_path))

    tagged = payload["stats"]["tagged"]
    print(
        f"完成：{len(payload['stocks'])} 只上榜，{tagged} 个席位命中标签，"
        f"净额 {fmt_amount(payload['stats']['net'])}"
    )
    print(f"  {html_path}")
    print(f"  {csv_path}")

    if args.open:
        webbrowser.open("file:///" + html_path.replace("\\", "/"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
