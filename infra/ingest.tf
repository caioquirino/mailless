data "archive_file" "ingest" {
  type        = "zip"
  source_file = var.ingest_bundle
  output_path = "${path.module}/.build/ingest.zip"
}

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/${var.name}-ingest"
  retention_in_days = var.log_retention_days
}

# Events that still fail after the automatic retries land here instead of being lost.
resource "aws_sqs_queue" "ingest_dead_letters" {
  name                      = "${var.name}-ingest-dead-letters"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ingest" {
  name               = "${var.name}-ingest"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "ingest" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.ingest.arn}:*"]
  }

  statement {
    sid       = "ReadAndRemoveInbound"
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.mail.arn}/${local.inbound_prefix}*"]
  }

  statement {
    sid       = "StoreMessages"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.mail.arn}/${local.blob_prefix}*"]
  }

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
    resources = [aws_sqs_queue.ingest_dead_letters.arn]
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

resource "aws_iam_role_policy" "ingest" {
  name   = "ingest"
  role   = aws_iam_role.ingest.id
  policy = data.aws_iam_policy_document.ingest.json
}

resource "aws_lambda_function" "ingest" {
  function_name = "${var.name}-ingest"
  role          = aws_iam_role.ingest.arn

  filename         = data.archive_file.ingest.output_path
  source_code_hash = data.archive_file.ingest.output_base64sha256
  handler          = "ingest.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]

  # SES accepts messages up to 40 MB; the function holds one in memory while parsing it.
  memory_size = 1024
  timeout     = 60

  environment {
    variables = {
      TABLE_NAME     = aws_dynamodb_table.metadata.name
      BUCKET         = aws_s3_bucket.mail.id
      INBOUND_PREFIX = local.inbound_prefix
      BLOB_PREFIX    = local.blob_prefix
      MAILBOXES      = jsonencode(var.mailboxes)
    }
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.ingest_dead_letters.arn
  }

  depends_on = [
    aws_cloudwatch_log_group.ingest,
    aws_iam_role_policy.ingest,
  ]
}

resource "aws_lambda_function_event_invoke_config" "ingest" {
  function_name                = aws_lambda_function.ingest.function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 21600
}

resource "aws_lambda_permission" "ses_invoke_ingest" {
  statement_id   = "AllowSesReceiptRule"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.ingest.function_name
  principal      = "ses.amazonaws.com"
  source_account = local.account_id
  source_arn     = local.receipt_rule_arn
}
