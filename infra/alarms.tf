# Alarms for the one thing the site cannot show for itself: whether
# listings are still arriving.
#
# On 2026-09-28 the fast scraper stopped delivering for 40 hours and
# nothing said so. /api/health was green (the database was up), the
# Lambda's own errors were a handful of out-of-memory kills the existing
# dashboards did not page on, and the big-tech scraper kept the newest
# listings looking alive. The one signal that was red the whole time was
# the age of the newest Greenhouse listing, and nobody was looking at it.
#
# So the box publishes that age for each main source (box/metrics.py,
# every fifteen minutes) and the alarms below watch it, alongside the
# fast scraper's own errors and duration and the applier's backlog. All
# of them post to one SNS topic with an email on it. Email, because it
# is free and this is a one-person project; the thresholds are set so a
# single bad run or one slow board never sends one, only a real stall.
# Recovery posts too, so an inbox tells the whole story.

resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-alerts"
  # The deploy role grants itself the SNS and alarm permissions in the
  # same apply (iam_oidc.tf), so that update has to land first.
  depends_on = [aws_iam_role_policy.infra_deploy]
}

# The address comes from the deploy workflow (ALERT_EMAIL, a repository
# variable), never from a committed default. Left empty, the alarms
# still exist and still change state; nobody is told.
resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  alarm_actions = [aws_sns_topic.alerts.arn]
  # The sources whose silence is an outage. Each posts many times an
  # hour; three quiet hours has never happened while the scraper worked.
  watched_sources = ["greenhouse", "ashby", "smartrecruiters"]
}

# No listing from a main source in three hours. Missing data counts as
# breaching: the metric stops arriving when the box's publisher stops,
# which is its own outage. Two 15-minute periods, so one late tick
# (the publisher skips a tick when an apply holds the lock) is not a page.
resource "aws_cloudwatch_metric_alarm" "source_stale" {
  for_each = toset(local.watched_sources)

  alarm_name          = "${var.project_name}-${each.key}-stale"
  alarm_description   = "No new ${each.key} listing has reached the board in three hours: the fast scraper (iljobs-scrape-fast) or the box's applier has stalled."
  namespace           = "OceanOfJobs"
  metric_name         = "SourceFreshnessMinutes"
  dimensions          = { ats = each.key }
  statistic           = "Maximum"
  period              = 900
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 180
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# The publisher has not finished a pass in two hours. It runs every
# fifteen minutes and sends PublishRuns at the end of each pass
# (box/metrics.py heartbeat), so silence is a stopped timer, a hung run,
# or a crash. Missing data is the alarm: on 2026-10-16 the timer was
# stopped and the sitemap, bootstrap and stats froze for four days while
# every other alarm stayed green. Six hours, past the service's 5h
# timeout: one pass with precompute in it ran 3h09m (2026-10-16), so
# two hours would alarm on every one.
resource "aws_cloudwatch_metric_alarm" "publish_stopped" {
  alarm_name          = "${var.project_name}-publish-stopped"
  alarm_description   = "The box's publisher (otj-publish) has not finished a pass in six hours: the sitemap, the board's first page and the stats are going stale. box/watchdog.sh should restart a stopped timer; check journalctl -u otj-publish."
  namespace           = "OceanOfJobs"
  metric_name         = "PublishRuns"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 6
  datapoints_to_alarm = 6
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Workers AI past 80% of the free 10,000 neurons a day. The API adds
# every AI answer's neurons to a daily total and sends it as
# AINeuronsToday (api/ai_answers.py), so this is the account's AI use
# today. Past 100% answers cost $0.011 per 1,000 neurons on Workers Paid,
# and on Workers Free they stop until 00:00 UTC.
resource "aws_cloudwatch_metric_alarm" "workers_ai_80" {
  alarm_name          = "${var.project_name}-workers-ai-80pct"
  alarm_description   = "Workers AI has used 80% of today's free 10,000 neurons (AI answers to application questions). Check usage in the Cloudflare dashboard, Workers AI."
  namespace           = "OceanOfJobs"
  metric_name         = "AINeuronsToday"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 8000
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# The fast scraper failing outright, three times in a quarter hour. One
# failure is a blip and the sweep after it carries on where it left off
# (it saves as it goes since 2026-09-30); three in a row is the memory or
# the runtime.
resource "aws_cloudwatch_metric_alarm" "scrape_fast_errors" {
  alarm_name          = "${var.project_name}-scrape-fast-errors"
  alarm_description   = "The fast scraper Lambda failed three or more times in fifteen minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.scrape_fast.function_name }
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# The fast scraper running long. It probes for five minutes
# (scrape_handler.py PROBE_DEADLINE_MIN, 5 since 2026-11-09) and then
# writes its fragments and state, so a busy run takes 5.3 to 6.6 minutes.
# Eight is past that and still short of the Lambda's 10-minute timeout:
# a run that long has boards hanging. At 5.5 minutes, the old line, it
# flapped every 10 to 15 minutes on normal runs the day the window grew.
resource "aws_cloudwatch_metric_alarm" "scrape_fast_slow" {
  alarm_name          = "${var.project_name}-scrape-fast-slow"
  alarm_description   = "The fast scraper Lambda is taking over eight minutes a run, well past its five-minute probe and close to its 10-minute timeout."
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  dimensions          = { FunctionName = aws_lambda_function.scrape_fast.function_name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 480000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Fragments piling up in S3: the scrapers are writing and the box is not
# applying. The applier takes them every minute, so in normal times the
# count sits near zero; fifty for three quarters of an hour is a stopped
# applier, not a busy morning.
resource "aws_cloudwatch_metric_alarm" "fragments_backlog" {
  alarm_name          = "${var.project_name}-fragments-backlog"
  alarm_description   = "More than fifty delta fragments have been waiting in S3 for 45 minutes: the box's applier (otj-apply) is not draining them."
  namespace           = "OceanOfJobs"
  metric_name         = "PendingFragments"
  statistic           = "Minimum"
  period              = 900
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 50
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Resolved companies the five-minute sweep never polls, because they are
# not in known.json (box/known_gap.py). Nothing puts a company back once
# it falls out of that file: on 2026-11-04, 1,372 boards (Buildots, Skai,
# DriveNets, SolarEdge, ...) had gone unpolled since September. A day
# above zero, so a company resolved by a discovery merge that reaches
# the database before known.json never sends one.
resource "aws_cloudwatch_metric_alarm" "companies_not_polled" {
  alarm_name          = "${var.project_name}-companies-not-polled"
  alarm_description   = "Resolved companies have been missing from known.json for a day, so the fast sweep never polls them. Run python box/known_gap.py on the box to list them."
  namespace           = "OceanOfJobs"
  metric_name         = "CompaniesNotPolled"
  statistic           = "Minimum"
  period              = 3600
  evaluation_periods  = 24
  datapoints_to_alarm = 24
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Boards the fast scraper's deadline stopped it reaching, every run for
# two hours: the work due each tick has outgrown one run, and every board
# waits in a queue that no longer drains. From 2026-11-02 to 11-08 a fixed
# cap of 900 left 10,157 boards waiting each run, unnoticed for six days;
# the cap is gone (loader/scrape_state.py), so this is now what would
# catch the same thing coming back. One datapoint a run, from the JSON
# line scrape_handler.py prints.
resource "aws_cloudwatch_log_metric_filter" "scrape_fast_deferred" {
  name           = "${var.project_name}-scrape-fast-deferred"
  log_group_name = aws_cloudwatch_log_group.scrape_fast_lambda.name
  pattern        = "{ $.sweep_deferred = * }"
  metric_transformation {
    name      = "ScrapeDeferredBoards"
    namespace = "OceanOfJobs"
    value     = "$.sweep_deferred"
  }
}

resource "aws_cloudwatch_metric_alarm" "scrape_fast_backlog" {
  alarm_name          = "${var.project_name}-scrape-fast-backlog"
  alarm_description   = "The fast scraper has left boards unpolled at its deadline on every run for two hours."
  namespace           = "OceanOfJobs"
  metric_name         = "ScrapeDeferredBoards"
  statistic           = "Minimum"
  period              = 900
  evaluation_periods  = 8
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# The box's disk past 85% for half an hour. box/watchdog.sh clears the
# known leftovers by itself and trims the journal at 90%; this is the
# email for growth it does not know about (2026-11-08: 88%, unnoticed).
# Open listings whose company has no name, so the site shows a bare
# domain. Sent once a day by box/apply_company_names.py. On 2026-11-08 it
# was 49,750 and nobody knew; the resolver's fallbacks bring it to about
# 3,000, so 10,000 means a resolver or the apply has stopped working.
resource "aws_cloudwatch_metric_alarm" "unnamed_open_jobs" {
  alarm_name          = "${var.project_name}-unnamed-open-jobs"
  alarm_description   = "Over 10,000 open listings show a domain instead of a company name."
  namespace           = "OceanOfJobs"
  metric_name         = "UnnamedOpenJobs"
  statistic           = "Maximum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 10000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "box_disk_full" {
  alarm_name          = "${var.project_name}-box-disk-full"
  alarm_description   = "The box's data disk has been over 85% full for half an hour."
  namespace           = "OceanOfJobs"
  metric_name         = "DiskUsedPercent"
  statistic           = "Maximum"
  period              = 900
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
