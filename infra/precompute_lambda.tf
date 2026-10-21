# /stats and /facets, computed on Lambda (precompute_handler.py) instead
# of on the box, where each run read a 7GB database about fifty times on
# a 4GB instance and starved the applier (3.5 hours a run, 2026-10-16).
#
# Restores jobs.db from the box's Litestream replica, runs the same
# loader/precompute.build, publishes the two artifacts. Starts in shadow
# mode, writing precomputed-shadow/ only, with the schedule off until a
# hand-invoked run has been measured. precompute_mode = "live" moves the
# production artifacts here; the box stops computing them at the same
# time (box/publish.py).

data "archive_file" "precompute" {
  type        = "zip"
  source_file = "${path.module}/../precompute_handler.py"
  output_path = "${path.module}/build/precompute.zip"
}

resource "aws_iam_role" "precompute_lambda" {
  name = "${var.project_name}-precompute-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "precompute_lambda" {
  name = "${var.project_name}-precompute-lambda-policy"
  role = aws_iam_role.precompute_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Litestream lists the replica to find its latest position, and a
        # HEAD on a missing artifact needs list rights to answer 404
        # rather than 403. jobs/ only: jobs-fts/ is not needed and stays
        # unreadable.
        Sid      = "ListReplicaAndArtifacts"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.data.arn
        Condition = {
          StringLike = { "s3:prefix" = ["litestream/v7/jobs", "litestream/v7/jobs/*", "precomputed/*", "precomputed-shadow/*"] }
        }
      },
      {
        Sid      = "ReadReplica"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.data.arn}/litestream/v7/jobs/*"
      },
      {
        # The two artifacts in each mode's prefix, read back for the
        # source-version guard, and the force marker a live run clears.
        Sid    = "WriteArtifacts"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject"]
        Resource = [
          "${aws_s3_bucket.data.arn}/precomputed/stats.json",
          "${aws_s3_bucket.data.arn}/precomputed/facets.json",
          "${aws_s3_bucket.data.arn}/precomputed-shadow/stats.json",
          "${aws_s3_bucket.data.arn}/precomputed-shadow/facets.json",
        ]
      },
      {
        Sid      = "ClearForceMarker"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.data.arn}/precomputed/force"
      },
      {
        # The browser's copies, live mode only, and the homepage's hot.json
        # in every mode.
        Sid    = "WriteFrontendCopies"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject"]
        Resource = [
          "${aws_s3_bucket.frontend.arn}/stats.json",
          "${aws_s3_bucket.frontend.arn}/facets.json",
          "${aws_s3_bucket.frontend.arn}/hot.json",
        ]
      },
      {
        Sid       = "Metrics"
        Effect    = "Allow"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "OceanOfJobs" } }
      },
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/aws/lambda/${var.project_name}-precompute*"
      }
    ]
  })
}

resource "aws_lambda_function" "precompute" {
  tags = { component = "precompute" }

  function_name    = "${var.project_name}-precompute"
  role             = aws_iam_role.precompute_lambda.arn
  handler          = "precompute_handler.lambda_handler"
  runtime          = "python3.13"
  architectures    = ["arm64"]
  filename         = data.archive_file.precompute.output_path
  source_code_hash = data.archive_file.precompute.output_base64sha256
  # This account's ceiling (see scrape_maintenance_memory_mb). The
  # restored file is 3.5GB, so some of it is read from local disk rather
  # than memory; the measured run decides whether that fits.
  memory_size = 3008
  timeout     = 900
  # One run at a time, so a slow run and the next scheduled one never
  # publish over each other.
  reserved_concurrent_executions = 1

  # The restored jobs.db (3.5GB and growing) plus Litestream's own
  # working files while it restores.
  ephemeral_storage {
    size = 10240
  }

  environment {
    variables = {
      DATA_BUCKET     = aws_s3_bucket.data.bucket
      FRONTEND_BUCKET = aws_s3_bucket.frontend.bucket
      PRECOMPUTE_MODE = var.precompute_mode
    }
  }

  # deploy-precompute-lambda.yml ships the real package (the handler,
  # loader/precompute.py, the API modules it imports and the Litestream
  # binary); this archive is the handler alone, to create the function.
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

resource "aws_cloudwatch_log_group" "precompute_lambda" {
  name              = "/aws/lambda/${aws_lambda_function.precompute.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_event_rule" "precompute_schedule" {
  name                = "${var.project_name}-precompute-schedule"
  description         = "Rebuilds /stats and /facets from the Litestream replica (precompute_handler.py)"
  schedule_expression = "rate(3 hours)"
  state               = var.precompute_schedule_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "precompute_schedule" {
  rule = aws_cloudwatch_event_rule.precompute_schedule.name
  arn  = aws_lambda_function.precompute.arn
}

resource "aws_lambda_permission" "allow_eventbridge_precompute" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.precompute.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.precompute_schedule.arn
}

# No retries: the next run is three hours away and starts from a fresh
# restore, and a retry of a failed build would only fail the same way.
resource "aws_lambda_function_event_invoke_config" "precompute" {
  function_name                = aws_lambda_function.precompute.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 3600
}

# Any failed run, scheduled or by hand.
resource "aws_cloudwatch_metric_alarm" "precompute_errors" {
  alarm_name          = "${var.project_name}-precompute-errors"
  alarm_description   = "The precompute Lambda failed. Nothing it had not finished and checked was published; the previous artifacts are still served. Its log has the reason."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.precompute.function_name }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Live only: the data behind the published stats is more than seven
# hours old (two missed runs), or no run has reported in that long.
resource "aws_cloudwatch_metric_alarm" "precompute_stale" {
  count               = var.precompute_mode == "live" ? 1 : 0
  alarm_name          = "${var.project_name}-precompute-stale"
  alarm_description   = "The live /stats and /facets artifacts are built from data more than 7 hours old, or the precompute Lambda has not reported. Check its log and the box's applier."
  namespace           = "OceanOfJobs"
  metric_name         = "PrecomputeSourceLagSeconds"
  dimensions          = { Mode = "live" }
  statistic           = "Minimum"
  period              = 25200
  evaluation_periods  = 1
  threshold           = 25200
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
