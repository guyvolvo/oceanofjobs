"""The Grafana Cloud growth dashboard, as code.

    python infra/grafana/growth_dashboard.py           writes growth-dashboard.json
    python infra/grafana/growth_dashboard.py --push    also sends it to Grafana

--push reads GRAFANA_URL (the stack, https://<name>.grafana.net) and
GRAFANA_TOKEN (a service account token with the Editor role) from the
environment or .env. Without them, import growth-dashboard.json by hand
under Dashboards > New > Import.

Styled after Cloudflare's analytics: a row of cards per section, each a
week's total with a sparkline and the change on the week before, then
thin line charts with the period's total in the legend, and stacked bars
where a total splits into kinds.

How a card gets its week-on-week change. Grafana's percent change is the
last point of a series against its first, and a time-shifted comparison
is still behind a feature flag. So a card asks for fourteen days of
hourly sums (empty hours filled with zero), turns them into a rolling
seven-day total, and keeps the last week of that: the first point is the
total as it stood seven days ago, the last is the total now, and the
sparkline is how the weekly total moved in between.

Everything reads CloudWatch through the data source that
infra/grafana_cloudwatch.tf's role serves:

  Events{event=...}       api/events.py, counted by frontend/count.js and
                          the API itself, summed per minute
  Accounts, ActiveAlerts, OpenListings and the like
                          box/growth.py, hourly gauges
  PendingFragments, SourceFreshnessMinutes
                          box/metrics.py, the pipeline's own health
  /iljobs/searches        the log group api/events.py writes search terms
                          to, read with Logs Insights for the two tables
  AWS/CloudFront          the edge, in us-east-1 as CloudFront's metrics
                          always are

No auto-refresh: each open of the dashboard is one batch of
GetMetricData calls, a fraction of a cent, and a refresh timer would
repeat that all day for nobody.
"""

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "growth-dashboard.json"
UID = "oceanofjobs-growth"
REGION = "il-central-1"
DISTRIBUTION = "E3UCZ5WT5SLUVY"
ACCOUNT = "876913698688"
SEARCH_LOG_GROUP = os.environ.get("SEARCH_LOG_GROUP", "/iljobs/searches")
DS = {"type": "cloudwatch", "uid": "${ds}"}
HOUR, WEEK_HOURS = "3600", 168

# Cloudflare's own series colours, in its order: blue first, then the
# amber, pink and purple its status-code bars use.
BLUE, AMBER, PINK, PURPLE, TEAL = "#3d8bf2", "#f5b726", "#e5609a", "#9b6cf0", "#2fc4b2"
SERIES = [BLUE, AMBER, PINK, PURPLE, TEAL]


def metric(ref, name, label="", stat="Sum", period=HOUR, dims=None, ns="OceanOfJobs", region=REGION,
           hide=False, exact=True):
    return {"datasource": DS, "refId": ref, "region": region, "namespace": ns, "metricName": name,
            "dimensions": dims or {}, "statistic": stat, "period": period, "matchExact": exact,
            "queryMode": "Metrics", "metricQueryType": 0, "metricEditorMode": 0, "id": ref.lower(),
            "expression": "", "label": label or name, "hide": hide}


def expr(ref, expression, label, period=HOUR, region=REGION):
    return {"datasource": DS, "refId": ref, "region": region, "queryMode": "Metrics", "metricQueryType": 0,
            "metricEditorMode": 1, "id": ref.lower(), "expression": expression, "label": label,
            "period": period, "namespace": "", "metricName": "", "dimensions": {}, "statistic": "Sum",
            "hide": False}


def event(ref, name, **kw):
    return metric(ref, "Events", dims={"event": name}, **kw)


def search(source, period=None) -> str:
    """A metric as a SEARCH inside one expression, summed to a single
    series. Each formula on this dashboard is one self-contained query:
    a formula that pointed at a hidden query by id failed now and then
    with "ID not found", depending on how Grafana's CloudWatch plugin
    batched the panel's queries (seen 2026-10-03, Grafana 13.2)."""
    dims = source.get("dimensions") or {}
    schema = ",".join([source["namespace"], *dims])
    terms = " ".join([f'MetricName="{source["metricName"]}"', *(f'{k}="{v}"' for k, v in dims.items())])
    return f"SUM(SEARCH('{{{schema}}} {terms}', '{source['statistic']}', {period or source['period']}))"


def filled(ref, source, label, period=HOUR, region=REGION):
    """A metric with its empty periods as zero: a quiet hour is a count
    of nothing, not a gap in the line."""
    return [expr(ref, f"FILL({search(source, period)}, 0)", label, period=period, region=region)]


def edge(ref, name, stat="Sum", **kw):
    return metric(ref, name, ns="AWS/CloudFront", region="us-east-1", stat=stat,
                  dims={"DistributionId": DISTRIBUTION, "Region": "Global"}, **kw)


def logs(ref, query):
    """A Logs Insights query on the search terms log group."""
    arn = f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:{SEARCH_LOG_GROUP}"
    return {"datasource": DS, "refId": ref, "region": REGION, "queryMode": "Logs", "id": "",
            "queryLanguage": "CWLI", "expression": query,
            "logGroups": [{"arn": arn, "name": SEARCH_LOG_GROUP}], "logGroupNames": [SEARCH_LOG_GROUP]}


def table(title, target, desc, columns, bar=None, sort=None):
    """A Cloudflare-style list: plain rows, the count drawn as a bar."""
    keep = {name: True for name in columns}
    overrides = []
    if bar:
        overrides.append({"matcher": {"id": "byName", "options": columns[bar]},
                          "properties": [{"id": "custom.cellOptions",
                                          "value": {"type": "gauge", "mode": "basic", "valueDisplayMode": "text"}},
                                         {"id": "color", "value": {"mode": "fixed", "fixedColor": BLUE}},
                                         {"id": "custom.width", "value": 260}]})
    return {
        "type": "table", "title": title, "description": desc, "targets": [target],
        "transformations": [{"id": "organize", "options": {
            "excludeByName": {}, "includeByName": keep, "renameByName": columns,
            "indexByName": {name: i for i, name in enumerate(columns)}}}],
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False},
                    "sortBy": [{"displayName": columns[sort], "desc": True}] if sort else []},
        "fieldConfig": {"defaults": {"custom": {"align": "auto", "filterable": False,
                                                "cellOptions": {"type": "auto"}}},
                        "overrides": overrides},
    }


class Layout:
    """Places panels left to right, wrapping at Grafana's 24 columns."""

    def __init__(self):
        self.panels, self.y, self.x, self.row_h, self.next_id = [], 0, 0, 0, 0

    def _id(self):
        self.next_id += 1
        return self.next_id

    def _wrap(self):
        if self.x:
            self.y += self.row_h
            self.x = self.row_h = 0

    def row(self, title):
        self._wrap()
        self.panels.append({"type": "row", "title": title, "collapsed": False, "id": self._id(),
                            "gridPos": {"h": 1, "w": 24, "x": 0, "y": self.y}, "panels": []})
        self.y += 1

    def add(self, panel, w, h):
        if self.x + w > 24:
            self._wrap()
        panel["id"] = self._id()
        panel["gridPos"] = {"h": h, "w": w, "x": self.x, "y": self.y}
        panel.setdefault("datasource", DS)
        self.panels.append(panel)
        self.x += w
        self.row_h = max(self.row_h, h)


def _defaults(unit, decimals, **rest):
    """Field defaults. No decimals means Grafana picks: 3.02 Mil, 14.1 GiB, 2."""
    out = {"unit": unit, **rest}
    if decimals is not None:
        out["decimals"] = decimals
    return out


def _card(title, targets, desc, unit, decimals, transformations, calc, change_colors, window):
    return {
        "type": "stat", "title": title, "description": desc, "targets": targets,
        "timeFrom": window, "hideTimeOverride": True, "transformations": transformations,
        "options": {"reduceOptions": {"calcs": [calc], "fields": "", "values": False},
                    "graphMode": "area", "colorMode": "none", "textMode": "value",
                    "justifyMode": "auto", "orientation": "auto", "wideLayout": False,
                    "showPercentChange": True,
                    "percentChangeColorMode": change_colors,
                    "text": {"titleSize": 13, "valueSize": 26}},
        "fieldConfig": {"defaults": _defaults(unit, decimals, noValue="0",
                                              color={"mode": "fixed", "fixedColor": BLUE}),
                        "overrides": []},
    }


def rolling_card(title, source, desc, unit="short", decimals=None, mean=False, inverted=False, region=REGION):
    """A week's total (or mean, for a rate), its sparkline, and the change
    on the week before. See the module docstring for how."""
    reducer_label = "7-day"
    transformations = [
        {"id": "calculateField", "options": {
            "mode": "windowFunctions", "alias": reducer_label, "replaceFields": False,
            "window": {"field": title, "reducer": "mean", "windowAlignment": "trailing",
                       "windowSizeMode": "fixed", "windowSize": WEEK_HOURS}}},
    ]
    if not mean:
        transformations.append({"id": "calculateField", "options": {
            "mode": "binary", "alias": title + " total", "replaceFields": True,
            "binary": {"left": {"matcher": {"id": "byName", "options": reducer_label}},
                       "operator": "*", "right": {"fixed": str(WEEK_HOURS)}}}})
    else:
        transformations.append({"id": "organize", "options": {"excludeByName": {title: True}}})
    transformations += [
        {"id": "sortBy", "options": {"sort": [{"field": "Time", "desc": True}]}},
        {"id": "limit", "options": {"limitField": WEEK_HOURS + 1}},
        {"id": "sortBy", "options": {"sort": [{"field": "Time", "desc": False}]}},
    ]
    return _card(title, filled("A", source, title, region=region), desc, unit, decimals, transformations,
                 "lastNotNull", "inverted" if inverted else "standard", "14d")


def gauge_card(title, source, desc, unit="short", decimals=None):
    """A level read hourly (accounts, listings): where it stands now, its
    last seven days as the sparkline, and the change across them. The
    change takes the value's colour: a level that held still is not bad
    news, and Grafana paints an unchanged 0% red."""
    return _card(title, [dict(source, label=title)], desc, unit, decimals, [], "lastNotNull", "same_as_value", "7d")


def chart(title, targets, desc, unit="short", decimals=None, bars=False, stacked=False, colors=None,
          legend_calc="sum", soft_max=None, palette=False):
    custom = {"drawStyle": "bars" if bars else "line", "lineWidth": 0 if bars else 2,
              "fillOpacity": 100 if bars else 0, "gradientMode": "none", "showPoints": "never",
              "spanNulls": True, "lineInterpolation": "linear", "barAlignment": 0, "barWidthFactor": 0.7,
              "axisBorderShow": False, "axisSoftMin": 0, "axisLabel": "", "axisPlacement": "auto",
              "stacking": {"mode": "normal" if stacked else "none", "group": "A"},
              "hideFrom": {"legend": False, "tooltip": False, "viz": False}}
    if soft_max is not None:
        custom["axisSoftMax"] = soft_max
    overrides = []
    for i, t in enumerate(x for x in targets if not x.get("hide") and not palette):
        color = (colors or SERIES)[i % len(colors or SERIES)]
        overrides.append({"matcher": {"id": "byName", "options": t["label"]},
                          "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": color}}]})
    return {
        "type": "timeseries", "title": title, "description": desc, "targets": targets,
        "options": {"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True,
                               "calcs": [legend_calc] if legend_calc else []},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
        "fieldConfig": {"defaults": _defaults(unit, decimals, custom=custom,
                                              color={"mode": "palette-classic"} if palette
                                              else {"mode": "fixed", "fixedColor": BLUE}),
                        "overrides": overrides},
    }


def build() -> dict:
    L = Layout()
    page = " Counted by the page itself (frontend/count.js), so crawlers and blocked scripts are left out."

    L.row("Visitors")
    for title, name, desc in [
        ("Visits", "visit", "Browser sessions that loaded any page, this week, against the week before." + page),
        ("New visitors", "new_visitor", "Visits from a browser never seen before." + page),
        ("Searches", "search", "Searches someone typed or picked on the board."),
        ("Job views", "job_view", "Listings opened on the board, or their own page loaded."),
        ("Apply clicks", "apply", "Clicks out to the employer's posting. The value the site delivers."),
        ("Sign-ins", "signin", "Completed sign-ins, any method."),
    ]:
        L.add(rolling_card(title, event("A", name), desc), 4, 5)
    L.add(chart("Visits over time", filled("A", event("A", "visit"), "Visits")
                + filled("B", event("B", "new_visitor"), "New visitors"),
                "Visits per hour, and how many came from a browser seen for the first time."), 12, 8)
    L.add(chart("Job views and apply clicks", filled("A", event("A", "job_view"), "Job views")
                + filled("B", event("B", "apply"), "Apply clicks"),
                "Listings opened, and clicks out to the employer, per hour."), 12, 8)
    L.add(chart("Searches", filled("A", event("A", "search"), "Searches"), "Board searches per hour.", bars=True), 12, 7)
    day = "86400"
    visits, applies = search(event("V", "visit"), day), search(event("P", "apply"), day)
    L.add(chart("Apply clicks per 100 visits",
                [expr("C", f"IF({visits} > 0, 100 * FILL({applies}, 0) / {visits}, 0)",
                      "Apply clicks per 100 visits", period=day)],
                "Of every hundred visits in a day, how many ended in a click out to an employer.",
                decimals=1, legend_calc="mean"), 12, 7)

    L.row("What people search")
    L.add(table("Top searches",
                logs("A", "fields term, n | stats sum(n) as searches by term | sort searches desc | limit 50"),
                "Searches typed or picked on the board in the selected range, most frequent first. "
                "From the board itself, so crawlers and API scripts aren't in it. Terms that look like an "
                "email address or a phone number are never kept.",
                {"term": "Search", "searches": "Times"}, bar="searches", sort="searches"), 12, 12)
    L.add(table("Recent searches",
                logs("A", "fields @timestamp, term, n | sort @timestamp desc | limit 100"),
                "The latest searches, to the minute. Times is how often that term was searched in that minute.",
                {"@timestamp": "When", "term": "Search", "n": "Times"}), 12, 12)

    L.row("Accounts and alerts")
    hourly = {"stat": "Maximum", "period": HOUR}
    L.add(gauge_card("Accounts", metric("A", "Accounts", **hourly), "Every account in the user pool, read hourly."), 4, 5)
    L.add(gauge_card("New accounts this week", metric("A", "NewAccounts7d", **hourly), "Accounts created in the last seven days."), 4, 5)
    L.add(gauge_card("Active alerts", metric("A", "ActiveAlerts", **hourly), "Alerts switched on."), 4, 5)
    L.add(gauge_card("People with alerts", metric("A", "UsersWithAlerts", **hourly), "Accounts with at least one alert on."), 4, 5)
    L.add(rolling_card("Alerts created", event("A", "alert_created"), "New alerts saved this week."), 4, 5)
    L.add(rolling_card("Digests sent", event("A", "digest_sent"),
                       "Alert emails sent this week. SES is still in its sandbox, so only verified addresses get them."), 4, 5)

    L.row("Traffic at the edge, crawlers included")
    L.add(rolling_card("Total requests", edge("A", "Requests"), "Every request CloudFront answered this week.",
                       region="us-east-1"), 6, 5)
    L.add(rolling_card("Data transfer", edge("A", "BytesDownloaded"), "Bytes sent to viewers this week.",
                       unit="bytes", decimals=2, region="us-east-1"), 6, 5)
    L.add(rolling_card("4xx error rate", edge("A", "4xxErrorRate", stat="Average"),
                       "Share of requests answered 4xx, averaged over the week.", unit="percent", decimals=2,
                       mean=True, inverted=True, region="us-east-1"), 6, 5)
    L.add(rolling_card("5xx error rate", edge("A", "5xxErrorRate", stat="Average"),
                       "Share of requests that failed on our side, averaged over the week.", unit="percent",
                       decimals=2, mean=True, inverted=True, region="us-east-1"), 6, 5)
    L.add(chart("Requests over time", [edge("A", "Requests", label="Requests")],
                "Requests per hour, people and crawlers alike."), 12, 8)
    L.add(chart("Data transfer", [edge("A", "BytesDownloaded", label="Data transfer")],
                "Bytes sent per hour.", unit="bytes", decimals=1), 12, 8)
    six = "21600"
    req = search(edge("R", "Requests"), six)
    e4 = f'FILL({search(edge("F", "4xxErrorRate", stat="Average"), six)}, 0)'
    e5 = f'FILL({search(edge("G", "5xxErrorRate", stat="Average"), six)}, 0)'
    L.add(chart("Requests by status code",
                [expr("A", f"{req} * (100 - {e4} - {e5}) / 100", "2xx and 3xx", period=six, region="us-east-1"),
                 expr("B", f"{req} * {e4} / 100", "4xx", period=six, region="us-east-1"),
                 expr("C", f"{req} * {e5} / 100", "5xx", period=six, region="us-east-1")],
                "Requests per six hours, split by CloudFront's 4xx and 5xx rates.",
                bars=True, stacked=True, colors=[BLUE, PINK, PURPLE]), 12, 8)
    L.add(chart("Error rates", [edge("A", "4xxErrorRate", stat="Average", label="4xx"),
                                edge("B", "5xxErrorRate", stat="Average", label="5xx")],
                "Share of requests that failed, per hour.", unit="percent", decimals=2,
                colors=[PINK, PURPLE], legend_calc="mean"), 12, 8)

    L.row("The board")
    L.add(gauge_card("Open listings", metric("A", "OpenListings", **hourly),
                     "Listings on the board, from the hourly precomputed stats."), 12, 5)
    L.add(gauge_card("Companies hiring", metric("A", "CompaniesHiring", **hourly),
                     "Companies with at least one open listing."), 12, 5)

    L.row("Pipeline health")
    L.add(chart("Pending fragments", [metric("A", "PendingFragments", "Pending fragments", stat="Maximum", period="300")],
                "Scraped changes waiting for the applier. Under 20 is normal.", legend_calc="max"), 12, 7)
    L.add(chart("Minutes since each source's newest listing",
                [metric("A", "SourceFreshnessMinutes", "${PROP('Dim.ats')}", stat="Maximum", period="300",
                        dims={"ats": "*"}, exact=False)],
                "Hours of silence from a source means a stalled scraper, not a quiet market.",
                unit="m", legend_calc="max", palette=True), 12, 7)

    return {
        "uid": UID, "title": "Ocean of Jobs: growth", "tags": ["oceanofjobs"], "timezone": "browser",
        "editable": True, "graphTooltip": 1, "refresh": "", "schemaVersion": 39, "version": 1,
        "time": {"from": "now-7d", "to": "now"},
        "templating": {"list": [{"name": "ds", "label": "CloudWatch", "type": "datasource", "query": "cloudwatch",
                                 "current": {}, "hide": 0, "refresh": 1, "regex": "", "options": []}]},
        "annotations": {"list": []}, "links": [], "panels": L.panels,
    }


def _env(name: str) -> str:
    if os.environ.get(name):
        return os.environ[name]
    env = HERE.parent.parent / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"')
    return ""


def push(dashboard: dict) -> str:
    import requests

    url, token = _env("GRAFANA_URL").rstrip("/"), _env("GRAFANA_TOKEN")
    if not (url and token):
        raise SystemExit("GRAFANA_URL and GRAFANA_TOKEN are not set; import growth-dashboard.json by hand instead")
    headers = {"Authorization": f"Bearer {token}"} if token != "anonymous" else {}
    r = requests.post(f"{url}/api/dashboards/db", timeout=30, headers=headers,
                      json={"dashboard": dashboard, "overwrite": True, "message": "growth_dashboard.py"})
    r.raise_for_status()
    return url + r.json().get("url", "")


if __name__ == "__main__":
    d = build()
    OUT.write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.name}: {sum(p['type'] != 'row' for p in d['panels'])} panels")
    if "--push" in sys.argv:
        print("pushed:", push(d))
