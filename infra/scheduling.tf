# Sending later. A mail app may ask for a message to be held, either for a few
# seconds so that "undo send" has something to undo, or until a date. Nothing
# runs while a message waits: a delayed queue message (up to 15 minutes, to the
# second) or a one-time schedule (longer, to the minute) wakes a function when
# the message is due.

data "archive_file" "send" {
  type        = "zip"
  source_file = var.send_bundle
  output_path = "${path.module}/.build/send.zip"
}

resource "aws_cloudwatch_log_group" "send" {
  name              = "/aws/lambda/${var.name}-send"
  retention_in_days = var.log_retention_days
}

# Wake-ups that kept failing. A message here is mail that was held and never sent.
resource "aws_sqs_queue" "send_dead_letters" {
  name                      = "${var.name}-send-dead-letters"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "send" {
  name                    = "${var.name}-send"
  sqs_managed_sse_enabled = true

  # Longer than the function may run, so a message is not handed out twice at once.
  visibility_timeout_seconds = 90

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.send_dead_letters.arn
    maxReceiveCount     = 5
  })
}

resource "aws_scheduler_schedule_group" "send" {
  name = var.name
}

# ---------------------------------------------------------------- the function

resource "aws_iam_role" "send" {
  name               = "${var.name}-send"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "send" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.send.arn}:*"]
  }

  # The held message is read, and removed once it has gone.
  statement {
    sid       = "HeldMessages"
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.mail.arn}/${local.blob_prefix}*"]
  }

  statement {
    sid       = "TellMissingFromForbidden"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.mail.arn]
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

  # As for the API: only as an address of this domain, and only through the
  # configuration set that reports what became of each message.
  statement {
    sid     = "SendMail"
    actions = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [
      "arn:${local.partition}:ses:${var.region}:${local.account_id}:identity/*",
      local.configuration_set_arn,
    ]

    condition {
      test     = "StringLike"
      variable = "ses:FromAddress"
      values   = ["*@${var.domain}"]
    }
  }

  statement {
    sid       = "ReadQueue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.send.arn]
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

resource "aws_iam_role_policy" "send" {
  name   = "send"
  role   = aws_iam_role.send.id
  policy = data.aws_iam_policy_document.send.json
}

resource "aws_lambda_function" "send" {
  function_name = "${var.name}-send"
  role          = aws_iam_role.send.arn

  filename         = data.archive_file.send.output_path
  source_code_hash = data.archive_file.send.output_base64sha256
  handler          = "send.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]

  # A message with attachments is held in memory while it is handed to SES.
  memory_size = 1024
  timeout     = 60

  environment {
    variables = {
      TABLE_NAME        = aws_dynamodb_table.metadata.name
      BUCKET            = aws_s3_bucket.mail.id
      BLOB_PREFIX       = local.blob_prefix
      CONFIGURATION_SET = aws_sesv2_configuration_set.main.configuration_set_name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.send,
    aws_iam_role_policy.send,
  ]
}

resource "aws_lambda_event_source_mapping" "send" {
  event_source_arn = aws_sqs_queue.send.arn
  function_name    = aws_lambda_function.send.arn
  # One message at a time: a failure then holds back nothing else.
  batch_size = 1

  depends_on = [aws_iam_role_policy.send]
}

# ------------------------------------------------- what the schedules run as

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    sid       = "WakeTheSendFunction"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.send.arn]
  }

  statement {
    sid       = "DeadLetters"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.send_dead_letters.arn]
  }

  # Calendar reminders wake the function that tells an account's devices.
  statement {
    sid       = "WakeForReminders"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.push_function_arn]
  }

  statement {
    sid       = "ReminderDeadLetters"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.push_dead_letters.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

# ------------------------------------------------ what the API may arrange

locals {
  schedule_arn_prefix = join(":", [
    "arn", local.partition, "scheduler", var.region, local.account_id,
    "schedule/${var.name}/",
  ])
}

data "aws_iam_policy_document" "api_scheduling" {
  statement {
    sid       = "QueueShortDelays"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.send.arn]
  }

  statement {
    sid       = "ScheduleLongDelays"
    actions   = ["scheduler:CreateSchedule", "scheduler:DeleteSchedule"]
    resources = ["${local.schedule_arn_prefix}*"]
  }

  # A schedule runs as the scheduler role, and may be given no other.
  statement {
    sid       = "HandOverTheSchedulerRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.scheduler.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "api_scheduling" {
  name   = "scheduling"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api_scheduling.json
}
