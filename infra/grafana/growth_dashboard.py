"""The Grafana Cloud growth dashboard, as code.

    python infra/grafana/growth_dashboard.py           writes growth-dashboard.json
    python infra/grafana/growth_dashboard.py --push    also sends it to Grafana

--push reads GRAFANA_URL (the stack, https://<name>.grafana.net) and
GRAFANA_TOKEN (a service account token with the Editor role) from the
environment or .env. Without them, import growth-dashboard.json by hand
under Dashboards > New > Import.

Everything here reads CloudWatch through the data source that
infra/grafana_cloudwatch.tf's role serves. Where the numbers come from:

  Events{event=...}       api/events.py, counted by frontend/count.js and
                          the API itself, summed per minute
  Accounts, ActiveAlerts, OpenListings and the like
                          box/growth.py, hourly gauges
  PendingFragments, SourceFreshnessMinutes
                          box/metrics.py, the pipeline's own health
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
DS = {"type": "cloudwatch", "uid": "${ds}"}
DAY, HOUR = "86400", "3600"


def q(ref, metric, label, stat="Sum", period=DAY, dims=None, ns="OceanOfJobs", region=REGION, hide=False, exact=True):
    return {"datasource": DS, "refId": ref, "region": region, "namespace": ns, "metricName": metric,
            "dimensions": dims or {}, "statistic": stat, "period": period, "matchExact": exact,
            "queryMode": "Metrics", "metricQueryType": 0, "metricEditorMode": 0, "id": ref.lower(),
            "expression": "", "label": label, "hide": hide}


def event(ref, name, label, **kw):
    return q(ref, "Events", label, dims={"event": name}, **kw)


def math(ref, expr, label, period=DAY):
    return {"datasource": DS, "refId": ref, "region": REGION, "queryMode": "Metrics", "metricQueryType": 0,
            "metricEditorMode": 1, "id": ref.lower(), "expression": expr, "label": label, "period": period,
            "namespace": "", "metricName": "", "dimensions": {}, "statistic": "Sum", "hide": False}


def edge(ref, metric, label, stat="Sum"):
    return q(ref, metric, label, stat=stat, ns="AWS/CloudFront", region="us-east-1",
             dims={"DistributionId": DISTRIBUTION, "Region": "Global"})


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


def stat(title, targets, desc, calc="sum", window="7d", unit="short", decimals=0):
    p = {"type": "stat", "title": title, "description": desc, "targets": targets,
         "options": {"reduceOptions": {"calcs": [calc], "fields": "", "values": False},
                     "graphMode": "area", "colorMode": "none", "textMode": "value",
                     "justifyMode": "auto", "orientation": "auto", "wideLayout": True},
         "fieldConfig": {"defaults": {"unit": unit, "decimals": decimals, "color": {"mode": "thresholds"},
                                      "thresholds": {"mode": "absolute", "steps": [{"color": "text", "value": None}]}},
                         "overrides": []}}
    if window:
        p["timeFrom"] = window
    return p


def series(title, targets, desc, bars=True, unit="short", decimals=0):
    return {"type": "timeseries", "title": title, "description": desc, "targets": targets,
            "options": {"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
                        "tooltip": {"mode": "multi", "sort": "none"}},
            "fieldConfig": {"defaults": {"unit": unit, "decimals": decimals, "color": {"mode": "palette-classic"},
                                         "custom": {"drawStyle": "bars" if bars else "line",
                                                    "fillOpacity": 70 if bars else 10, "lineWidth": 2,
                                                    "barAlignment": 0, "showPoints": "never",
                                                    "spanNulls": not bars, "axisSoftMin": 0}},
                            "overrides": []}}


def build() -> dict:
    L = Layout()
    page = "Counted by the page itself (frontend/count.js), so crawlers and blocked scripts are left out."
    hourly = {"stat": "Maximum", "period": HOUR}

    L.row("Last 7 days")
    L.add(stat("Visits", [event("A", "visit", "Visits")], "Browser sessions that loaded any page. " + page), 4, 4)
    L.add(stat("New visitors", [event("A", "new_visitor", "New visitors")], "First visit from this browser. " + page), 4, 4)
    L.add(stat("Searches", [event("A", "search", "Searches")], "Text searches run on the board, one per search asked for."), 4, 4)
    L.add(stat("Job views", [event("A", "job_view", "Job views")], "A listing opened on the board, or its own page loaded."), 4, 4)
    L.add(stat("Apply clicks", [event("A", "apply", "Apply clicks")],
               "Clicks out to the employer's posting. The value the site delivers."), 4, 4)
    L.add(stat("Sign-ins", [event("A", "signin", "Sign-ins")], "Completed sign-ins, any method."), 4, 4)

    L.add(stat("Accounts", [q("A", "Accounts", "Accounts", **hourly)],
               "Every account in the user pool (box/growth.py, hourly).", calc="lastNotNull", window=None), 4, 4)
    L.add(stat("New accounts this week", [q("A", "NewAccounts7d", "New accounts", **hourly)],
               "Accounts created in the last 7 days.", calc="lastNotNull", window=None), 4, 4)
    L.add(stat("Active alerts", [q("A", "ActiveAlerts", "Active alerts", **hourly)],
               "Alerts switched on.", calc="lastNotNull", window=None), 4, 4)
    L.add(stat("People with alerts", [q("A", "UsersWithAlerts", "People with alerts", **hourly)],
               "Accounts with at least one alert on.", calc="lastNotNull", window=None), 4, 4)
    L.add(stat("Alerts created", [event("A", "alert_created", "Alerts created")], "New alerts saved."), 4, 4)
    L.add(stat("Digests sent", [event("A", "digest_sent", "Digests sent")],
               "Alert emails sent. SES is still in its sandbox, so only verified addresses receive them."), 4, 4)

    L.row("Daily")
    L.add(series("Visits", [event("A", "visit", "Visits"), event("B", "new_visitor", "New visitors")],
                 "Sessions per day, and how many came from a browser seen for the first time."), 12, 8)
    L.add(series("Job views and apply clicks", [event("A", "job_view", "Job views"), event("B", "apply", "Apply clicks")],
                 "Listings opened, and clicks out to the employer."), 12, 8)
    L.add(series("Searches", [event("A", "search", "Searches")], "Board searches per day."), 12, 8)
    L.add(series("Apply clicks per 100 visits",
                 [event("A", "apply", "Apply", hide=True), event("B", "visit", "Visits", hide=True),
                  math("C", "IF(b > 0, 100 * a / b, 0)", "Apply clicks per 100 visits")],
                 "Of every hundred visits, how many end in a click out to an employer.", bars=False, decimals=1), 12, 8)
    L.add(series("Accounts", [q("A", "Accounts", "Accounts", **hourly)],
                 "The user pool's size over time.", bars=False), 12, 8)
    L.add(series("Alerts", [q("A", "ActiveAlerts", "Active alerts", **hourly),
                            q("B", "UsersWithAlerts", "People with alerts", **hourly)],
                 "Alerts switched on, and the people they belong to.", bars=False), 12, 8)

    L.row("The board")
    L.add(series("Open listings", [q("A", "OpenListings", "Open listings", **hourly)],
                 "Listings on the board, from the hourly precomputed stats.", bars=False), 12, 7)
    L.add(series("Companies hiring", [q("A", "CompaniesHiring", "Companies hiring", **hourly)],
                 "Companies with at least one open listing.", bars=False), 12, 7)

    L.row("Edge traffic, crawlers included")
    L.add(series("Requests", [edge("A", "Requests", "Requests")],
                 "Every request CloudFront answered, people and crawlers alike."), 8, 7)
    L.add(series("Data out", [edge("A", "BytesDownloaded", "Bytes")], "Bytes sent to viewers.", unit="bytes"), 8, 7)
    L.add(series("Error rates", [edge("A", "4xxErrorRate", "4xx", stat="Average"),
                                 edge("B", "5xxErrorRate", "5xx", stat="Average")],
                 "Share of requests that failed, in percent.", bars=False, unit="percent", decimals=2), 8, 7)

    L.row("Pipeline health")
    L.add(series("Pending fragments", [q("A", "PendingFragments", "Pending fragments", stat="Maximum", period="300")],
                 "Scraped changes waiting for the applier. Under 20 is normal.", bars=False), 12, 7)
    L.add(series("Minutes since each source's newest listing",
                 [q("A", "SourceFreshnessMinutes", "{{ats}}", stat="Maximum", period="300",
                    dims={"ats": "*"}, exact=False)],
                 "Hours of silence from a source means a stalled scraper, not a quiet market.",
                 bars=False, unit="m"), 12, 7)

    return {
        "uid": UID, "title": "Ocean of Jobs: growth", "tags": ["oceanofjobs"], "timezone": "browser",
        "editable": True, "graphTooltip": 1, "refresh": "", "schemaVersion": 39, "version": 1,
        "time": {"from": "now-30d", "to": "now"},
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
    r = requests.post(f"{url}/api/dashboards/db", timeout=30,
                      headers={"Authorization": f"Bearer {token}"},
                      json={"dashboard": dashboard, "overwrite": True, "message": "growth_dashboard.py"})
    r.raise_for_status()
    return url + r.json().get("url", "")


if __name__ == "__main__":
    d = build()
    OUT.write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.name}: {sum(p['type'] != 'row' for p in d['panels'])} panels")
    if "--push" in sys.argv:
        print("pushed:", push(d))
