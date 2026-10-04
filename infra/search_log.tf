# What people search on the board, for the growth dashboard's tables.
#
# api/events.py writes one line per term per minute, {"term": ..., "n": ...},
# from the search count frontend/count.js sends. Nothing identifying the
# searcher is in it, and terms that look like an email address or a phone
# number are dropped before they get here. The box writes with its own
# role (otj-box-searches, box/CUTOVER.md); Grafana reads with
# grafana_cloudwatch.tf's.
#
# Ninety days is enough to see what people look for this quarter, and
# short enough that an odd term doesn't sit here for good.

resource "aws_cloudwatch_log_group" "searches" {
  name              = "/${var.project_name}/searches"
  retention_in_days = 90

  # The deploy role may create this only once its own policy allows the
  # /iljobs/ prefix, which the same apply grants (iam_oidc.tf).
  depends_on = [aws_iam_role_policy.infra_deploy]
}
