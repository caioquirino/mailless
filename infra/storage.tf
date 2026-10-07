# ----------------------------------------------------------------- encryption

data "aws_iam_policy_document" "kms" {
  count = var.use_customer_kms_key ? 1 : 0

  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  # SES writes inbound mail into the bucket, which encrypts with this key on its behalf.
  statement {
    sid       = "SesInboundMail"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "mail" {
  count = var.use_customer_kms_key ? 1 : 0

  description             = "${var.name}: mail content and metadata"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms[0].json
}

resource "aws_kms_alias" "mail" {
  count = var.use_customer_kms_key ? 1 : 0

  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.mail[0].key_id
}

locals {
  kms_key_arn = var.use_customer_kms_key ? aws_kms_key.mail[0].arn : null
}

# ----------------------------------------------------------------------- mail

resource "aws_s3_bucket" "mail" {
  bucket = "${var.name}-mail-${local.account_id}-${var.region}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "mail" {
  bucket = aws_s3_bucket.mail.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "mail" {
  bucket = aws_s3_bucket.mail.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id

  rule {
    bucket_key_enabled = var.use_customer_kms_key

    apply_server_side_encryption_by_default {
      sse_algorithm     = var.use_customer_kms_key ? "aws:kms" : "AES256"
      kms_master_key_id = local.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id

  # Imported messages are deleted from inbound/ straight away. What is left
  # could not be imported and is kept briefly for inspection.
  rule {
    id     = "expire-unprocessed-inbound"
    status = "Enabled"

    filter {
      prefix = local.inbound_prefix
    }

    expiration {
      days = var.inbound_retention_days
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "mail_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.mail.arn, "${aws_s3_bucket.mail.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Only this stack's receipt rule may write, and only under inbound/.
  statement {
    sid       = "SesInboundMail"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.mail.arn}/${local.inbound_prefix}*"]

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
      values   = [local.receipt_rule_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "mail" {
  bucket = aws_s3_bucket.mail.id
  policy = data.aws_iam_policy_document.mail_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.mail]
}

# ------------------------------------------------------------------- metadata

# Key schema must match tableDefinition() in @mailless/storage-dynamodb.
resource "aws_dynamodb_table" "metadata" {
  name                        = "${var.name}-metadata"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = var.use_customer_kms_key
    kms_key_arn = local.kms_key_arn
  }

  lifecycle {
    prevent_destroy = true
  }
}
