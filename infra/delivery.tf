# What happens to mail after it is sent. SES publishes delivery, bounce,
# complaint, delay and reject events for every message; a function records the
# outcome on the sent message, and alarms watch the account's reputation.

locals {
  configuration_set_arn = join(":", [
    "arn", local.partition, "ses", var.region, local.account_id,
    "configuration-set/${var.name}",
  ])
}

resource "aws_sesv2_configuration_set" "main" {
  configuration_set_name = var.name

  reputation_options {
    reputation_metrics_enabled = true
  }

  # Never send again to an address that hard-bounced or complained.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sns_topic" "delivery_events" {
  name              = "${var.name}-delivery-events"
  kms_master_key_id = local.kms_key_arn
}

data "aws_iam_policy_document" "delivery_events_topic" {
  statement {
    sid       = "SesPublishesEvents"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.delivery_events.arn]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.configuration_set_arn]
    }
  }
}

resource "aws_sns_topic_policy" "delivery_events" {
  arn    = aws_sns_topic.delivery_events.arn
  policy = data.aws_iam_policy_document.delivery_events_topic.json
}

resource "aws_sesv2_configuration_set_event_destination" "delivery" {
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name
  event_destination_name = "delivery-events"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT", "DELIVERY", "DELIVERY_DELAY", "REJECT"]

    sns_destination {
      topic_arn = aws_sns_topic.delivery_events.arn
    }
  }

  depends_on = [aws_sns_topic_policy.delivery_events]
}

# ------------------------------------------------------------- event function

data "archive_file" "events" {
  type        = "zip"
  source_file = var.events_bundle
  output_path = "${path.module}/.build/events.zip"
}

resource "aws_cloudwatch_log_group" "events" {
  name              = "/aws/lambda/${var.name}-delivery-events"
  retention_in_days = var.log_retention_days
}

resource "aws_sqs_queue" "events_dead_letters" {
  name                      = "${var.name}-delivery-events-dead-letters"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_iam_role" "events" {
  name               = "${var.name}-delivery-events"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "events" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.events.arn}:*"]
  }

  # Delivery outcomes are recorded on the sent message's metadata. No mail content is read.
  statement {
    sid = "Metadata"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [aws_dynamodb_table.metadata.arn]
  }

  statement {
    sid       = "DeadLetters"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.events_dead_letters.arn]
  }

  dynamic "statement" {
    for_each = var.use_customer_kms_key ? [1] : []

    content {
      sid       = "Encryption"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [local.kms_key_arn]
    }
  }
}

resource "aws_iam_role_policy" "events" {
  name   = "delivery-events"
  role   = aws_iam_role.events.id
  policy = data.aws_iam_policy_document.events.json
}

resource "aws_lambda_function" "events" {
  function_name = "${var.name}-delivery-events"
  role          = aws_iam_role.events.arn

  filename         = data.archive_file.events.output_path
  source_code_hash = data.archive_file.events.output_base64sha256
  handler          = "events.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]

  memory_size = 256
  timeout     = 30

  environment {
    variables = {
      TABLE_NAME  = aws_dynamodb_table.metadata.name
      BUCKET      = aws_s3_bucket.mail.id
      BLOB_PREFIX = local.blob_prefix
    }
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.events_dead_letters.arn
  }

  depends_on = [
    aws_cloudwatch_log_group.events,
    aws_iam_role_policy.events,
  ]
}

resource "aws_lambda_permission" "sns_invoke_events" {
  statement_id  = "AllowDeliveryEventsTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.events.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.delivery_events.arn
}

resource "aws_sns_topic_subscription" "events" {
  topic_arn = aws_sns_topic.delivery_events.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.events.arn

  depends_on = [aws_lambda_permission.sns_invoke_events]
}

# --------------------------------------------------------------------- alarms

resource "aws_sns_topic" "alarms" {
  name = "${var.name}-alarms"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count = var.alarm_email == null ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  # SES reviews an account at 5% bounces or 0.1% complaints, and pauses sending at 10% and 0.5%.
  # These fire earlier, while there is still time to act.
  reputation_alarms = {
    bounce-rate = {
      metric      = "Reputation.BounceRate"
      threshold   = 0.04
      description = "More than 4% of sent mail is bouncing. SES puts accounts under review at 5%."
    }
    complaint-rate = {
      metric      = "Reputation.ComplaintRate"
      threshold   = 0.0008
      description = "More than 0.08% of sent mail is marked as spam. SES puts accounts under review at 0.1%."
    }
  }

  dead_letter_queues = {
    ingest          = aws_sqs_queue.ingest_dead_letters.name
    delivery-events = aws_sqs_queue.events_dead_letters.name
    push            = aws_sqs_queue.push_dead_letters.name
    scheduled-send  = aws_sqs_queue.send_dead_letters.name
  }
}

resource "aws_cloudwatch_metric_alarm" "reputation" {
  for_each = local.reputation_alarms

  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = "AWS/SES"
  metric_name         = each.value.metric
  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = each.value.threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# A message in one of these queues is mail, a delivery report or a batch of changes that could not be processed.
resource "aws_cloudwatch_metric_alarm" "dead_letters" {
  for_each = local.dead_letter_queues

  alarm_name          = "${var.name}-${each.key}-dead-letters"
  alarm_description   = "The ${each.key} function failed to process something after all its retries."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
