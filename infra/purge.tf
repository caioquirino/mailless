# Removing the mail of a closed account. The admin function closes an account
# and leaves a message here; this function removes what the account had and
# then the account itself, which frees its id. It is the one function that may
# empty a mailbox, and it will only empty one the directory says is closed.

data "archive_file" "purge" {
  type        = "zip"
  source_file = var.purge_bundle
  output_path = "${path.module}/.build/purge.zip"
}

resource "aws_cloudwatch_log_group" "purge" {
  name              = "/aws/lambda/${var.name}-purge"
  retention_in_days = var.log_retention_days
}

# Removals that kept failing. A message here is an account still listed as
# closed with mail left behind; asking again from the admin interface retries.
resource "aws_sqs_queue" "purge_dead_letters" {
  name                      = "${var.name}-purge-dead-letters.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

# First in, first out, with the account as the group: two requests for one
# account are never worked on at once. A removal therefore always starts by
# seeing what the one before it left, and one that finds the account gone, or
# open again under a new owner, touches nothing.
resource "aws_sqs_queue" "purge" {
  name                    = "${var.name}-purge.fifo"
  fifo_queue              = true
  sqs_managed_sse_enabled = true

  # The functions that handle mail remember what the directory said for a
  # minute. A removal starts after that, so that none of them still takes the
  # account for open and writes to it behind the purge.
  delay_seconds = 120

  # Longer than the function may run, so a message is not handed out twice at once.
  visibility_timeout_seconds = 960

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.purge_dead_letters.arn
    maxReceiveCount     = 5
  })
}

resource "aws_iam_role" "purge" {
  name               = "${var.name}-purge"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "purge" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.purge.arn}:*"]
  }

  # Stored mail can be removed and not read: no GetObject.
  statement {
    sid       = "RemoveBlobs"
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.mail.arn}/${local.blob_prefix}*"]
  }

  statement {
    sid       = "ListBlobs"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.mail.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.blob_prefix}*"]
    }
  }

  # Finding what an account has is a query per partition; removing it, batches
  # of deletes. A batch could also put items, which IAM cannot tell apart; the
  # function never does.
  statement {
    sid       = "RemoveMetadata"
    actions   = ["dynamodb:Query", "dynamodb:BatchWriteItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.metadata.arn]
  }

  # Whether the account is closed, and, once nothing of it is left, its removal.
  statement {
    sid       = "Directory"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.directory.arn]
  }

  # Reading requests, and leaving one for the next run when a mailbox is too
  # large for this one.
  statement {
    sid = "Queue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:SendMessage",
    ]
    resources = [aws_sqs_queue.purge.arn]
  }

  dynamic "statement" {
    for_each = var.use_customer_kms_key ? [1] : []

    content {
      sid       = "Encryption"
      actions   = ["kms:Decrypt"]
      resources = [local.kms_key_arn]
    }
  }
}

resource "aws_iam_role_policy" "purge" {
  name   = "purge"
  role   = aws_iam_role.purge.id
  policy = data.aws_iam_policy_document.purge.json
}

resource "aws_lambda_function" "purge" {
  function_name = "${var.name}-purge"
  role          = aws_iam_role.purge.arn

  filename         = data.archive_file.purge.output_path
  source_code_hash = data.archive_file.purge.output_base64sha256
  handler          = "purge.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]

  memory_size = 512
  # As long as a function may run. A mailbox that takes longer is carried on
  # by a second run: the function stops a minute short and leaves a message.
  timeout = 900

  environment {
    variables = {
      TABLE_NAME      = aws_dynamodb_table.metadata.name
      DIRECTORY_TABLE = aws_dynamodb_table.directory.name
      BUCKET          = aws_s3_bucket.mail.id
      BLOB_PREFIX     = local.blob_prefix
      PURGE_QUEUE_URL = aws_sqs_queue.purge.url
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.purge,
    aws_iam_role_policy.purge,
  ]
}

resource "aws_lambda_event_source_mapping" "purge" {
  event_source_arn = aws_sqs_queue.purge.arn
  function_name    = aws_lambda_function.purge.arn
  # One account at a time: a failure then holds back nothing else.
  batch_size = 1

  depends_on = [aws_iam_role_policy.purge]
}

# ------------------------------------------- what the admin function may ask

# It may ask for a removal, and that is all it has to do with stored mail: it
# can neither read nor remove any itself.
data "aws_iam_policy_document" "admin_purge" {
  statement {
    sid       = "RequestPurge"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.purge.arn]
  }
}

resource "aws_iam_role_policy" "admin_purge" {
  name   = "purge"
  role   = aws_iam_role.admin.id
  policy = data.aws_iam_policy_document.admin_purge.json
}
