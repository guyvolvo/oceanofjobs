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

# The fast scraper running long. It stops taking boards at five minutes
# and is normally done in two or three; a run past five and a half is
# one whose boards in flight are hanging, and two of three such runs
# means the boards, not the weather.
resource "aws_cloudwatch_metric_alarm" "scrape_fast_slow" {
  alarm_name          = "${var.project_name}-scrape-fast-slow"
  alarm_description   = "The fast scraper Lambda is taking over five and a half minutes a run, past its own deadline."
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  dimensions          = { FunctionName = aws_lambda_function.scrape_fast.function_name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 330000
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
