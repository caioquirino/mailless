# Telling mail apps that something changed. Apps register a push subscription
# through the API; the metadata table's stream then reports every change, and a
# function forwards it to each subscription's push service. A push says which
# kinds of data changed and nothing about the mail itself.

data "archive_file" "push" {
  type        = "zip"
  source_file = var.push_bundle
  output_path = "${path.module}/.build/push.zip"
}

resource "aws_cloudwatch_log_group" "push" {
  name              = "/aws/lambda/${var.name}-push"
  retention_in_days = var.log_retention_days
}

# Batches of changes the function failed on after its retries. Each entry names
# a position in the stream, not the data.
resource "aws_sqs_queue" "push_dead_letters" {
  name                      = "${var.name}-push-dead-letters"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_iam_role" "push" {
  name               = "${var.name}-push"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "push" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.push.arn}:*"]
  }

  statement {
    sid = "ReadChanges"
    actions = [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:ListStreams",
    ]
    resources = [aws_dynamodb_table.metadata.stream_arn]
  }

  # Reads subscriptions and current states; writes only to remove a subscription
  # that expired or to note that its push service asked for a pause. No mail content is read.
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
    resources = [aws_sqs_queue.push_dead_letters.arn]
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

resource "aws_iam_role_policy" "push" {
  name   = "push"
  role   = aws_iam_role.push.id
  policy = data.aws_iam_policy_document.push.json
}

resource "aws_lambda_function" "push" {
  function_name = "${var.name}-push"
  role          = aws_iam_role.push.arn

  filename         = data.archive_file.push.output_path
  source_code_hash = data.archive_file.push.output_base64sha256
  handler          = "push.handler"
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

  depends_on = [
    aws_cloudwatch_log_group.push,
    aws_iam_role_policy.push,
  ]
}

resource "aws_lambda_event_source_mapping" "push" {
  event_source_arn  = aws_dynamodb_table.metadata.stream_arn
  function_name     = aws_lambda_function.push.arn
  starting_position = "LATEST"

  # Changes made within the same second go out as one push.
  batch_size                         = 100
  maximum_batching_window_in_seconds = 1

  # A push that could not be made is soon out of date; the next change sends a current one.
  maximum_retry_attempts        = 2
  maximum_record_age_in_seconds = 300

  # Every commit writes one state item per kind of data it changed (see
  # STATE_KEY_PREFIX in @mailless/storage-dynamodb). Nothing else invokes the function.
  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["INSERT", "MODIFY"]
        dynamodb  = { Keys = { pk = { S = [{ prefix = "S#" }] } } }
      })
    }
  }

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.push_dead_letters.arn
    }
  }

  depends_on = [aws_iam_role_policy.push]
}
