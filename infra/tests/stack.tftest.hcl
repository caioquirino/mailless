# Plan-level tests with a mocked AWS provider: no credentials, nothing created.
# Run with `terraform test` (or `pnpm nx test infra`).

mock_provider "aws" {
  # Make mocked values known while planning, so assertions can read ARNs and names.
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_data {
    target = data.aws_partition.current
    values = {
      partition = "aws"
    }
  }

  override_resource {
    target = aws_sesv2_email_identity.domain
    values = {
      dkim_signing_attributes = {
        tokens = ["tokena", "tokenb", "tokenc"]
      }
    }
  }

  # ARNs that IAM policies reference, so the policies can be inspected while planning.
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::mock-bucket"
    }
  }

  mock_resource "aws_dynamodb_table" {
    defaults = {
      arn = "arn:aws:dynamodb:eu-west-1:123456789012:table/mock-table"
    }
  }

  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:eu-west-1:123456789012:mock-queue"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:eu-west-1:123456789012:log-group:mock-group"
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:eu-west-1:123456789012:key/mock-key"
    }
  }

  # A mocked policy document would otherwise render as a random string, which is not valid JSON.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  region                    = "eu-west-1"
  domain                    = "example.com"
  mailboxes                 = { "me@example.com" = "me", "*@example.com" = "catchall" }
  activate_receipt_rule_set = false
  ingest_bundle             = "tests/fixture-bundle.mjs"
}

run "defaults" {
  command = plan

  assert {
    condition     = length(aws_route53_record.mail) == 0
    error_message = "No DNS records may be created without a hosted zone."
  }

  assert {
    condition     = length(aws_ses_active_receipt_rule_set.main) == 0
    error_message = "The receipt rule set must not be activated unless asked."
  }

  assert {
    condition     = output.dns_records["mx"].value == "10 inbound-smtp.eu-west-1.amazonaws.com"
    error_message = "The MX record must point at the SES inbound endpoint of the region."
  }

  assert {
    condition = (
      length(output.dns_records) == 4 &&
      output.dns_records["dkim0"].name == "tokena._domainkey.example.com" &&
      output.dns_records["dkim2"].value == "tokenc.dkim.amazonses.com"
    )
    error_message = "There must be one MX and three DKIM records."
  }

  assert {
    condition     = length(aws_kms_key.mail) == 1 && aws_kms_key.mail[0].enable_key_rotation
    error_message = "A rotating customer-managed key is the default."
  }

  assert {
    condition = one([
      for rule in aws_s3_bucket_server_side_encryption_configuration.mail.rule :
      rule.apply_server_side_encryption_by_default[0].sse_algorithm
    ]) == "aws:kms"
    error_message = "The mail bucket must default to KMS encryption."
  }

  assert {
    condition     = aws_s3_bucket.mail.bucket == "mailless-mail-123456789012-eu-west-1"
    error_message = "Unexpected bucket name."
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.mail.block_public_acls &&
      aws_s3_bucket_public_access_block.mail.block_public_policy &&
      aws_s3_bucket_public_access_block.mail.ignore_public_acls &&
      aws_s3_bucket_public_access_block.mail.restrict_public_buckets
    )
    error_message = "All public access must be blocked on the mail bucket."
  }

  assert {
    condition = (
      aws_dynamodb_table.metadata.billing_mode == "PAY_PER_REQUEST" &&
      aws_dynamodb_table.metadata.hash_key == "pk" &&
      aws_dynamodb_table.metadata.range_key == "sk" &&
      aws_dynamodb_table.metadata.deletion_protection_enabled &&
      aws_dynamodb_table.metadata.point_in_time_recovery[0].enabled
    )
    error_message = "The table must be on-demand with pk/sk keys, deletion protection and point-in-time recovery."
  }

  assert {
    condition = (
      aws_ses_receipt_rule.inbound.recipients == toset(["example.com"]) &&
      aws_ses_receipt_rule.inbound.scan_enabled &&
      aws_ses_receipt_rule.inbound.tls_policy == "Require"
    )
    error_message = "The receipt rule must cover the domain, scan for spam and viruses, and require TLS."
  }

  assert {
    condition = (
      one(aws_ses_receipt_rule.inbound.s3_action).position == 1 &&
      one(aws_ses_receipt_rule.inbound.s3_action).object_key_prefix == "inbound/" &&
      one(aws_ses_receipt_rule.inbound.lambda_action).position == 2 &&
      one(aws_ses_receipt_rule.inbound.lambda_action).invocation_type == "Event"
    )
    error_message = "The message must be stored in S3 before the function is invoked."
  }

  assert {
    condition = (
      aws_lambda_permission.ses_invoke_ingest.source_account == "123456789012" &&
      aws_lambda_permission.ses_invoke_ingest.source_arn == "arn:aws:ses:eu-west-1:123456789012:receipt-rule-set/mailless:receipt-rule/mailless-inbound"
    )
    error_message = "Only this stack's receipt rule may invoke the function."
  }

  assert {
    condition = (
      aws_lambda_function.ingest.runtime == "nodejs24.x" &&
      aws_lambda_function.ingest.architectures == tolist(["arm64"]) &&
      aws_lambda_function.ingest.handler == "ingest.handler" &&
      aws_lambda_function.ingest.environment[0].variables["MAILBOXES"] == jsonencode(var.mailboxes) &&
      aws_lambda_function.ingest.environment[0].variables["INBOUND_PREFIX"] == "inbound/" &&
      aws_lambda_function.ingest.environment[0].variables["BLOB_PREFIX"] == "blobs/"
    )
    error_message = "Unexpected ingest function configuration."
  }

  # Least privilege: nothing in the function's policy may be a wildcard resource or action.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.ingest.statement :
      !contains(statement.resources, "*") && alltrue([for action in statement.actions : !endswith(action, ":*") && action != "*"])
    ])
    error_message = "The ingest role must not use wildcard actions or resources."
  }

  assert {
    condition = toset([
      for statement in data.aws_iam_policy_document.ingest.statement : statement.sid
    ]) == toset(["Logs", "ReadAndRemoveInbound", "StoreMessages", "Metadata", "DeadLetters", "Encryption"])
    error_message = "Unexpected statements in the ingest role policy."
  }

  # SES may write to the bucket only from this account and this receipt rule.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.mail_bucket.statement :
      toset([for condition in statement.condition : condition.variable]) == toset(["aws:SourceAccount", "aws:SourceArn"])
      if statement.sid == "SesInboundMail"
    ])
    error_message = "The SES bucket statement must be restricted by source account and source ARN."
  }
}

run "with_hosted_zone_and_activation" {
  command = plan

  variables {
    route53_zone_id           = "Z0123456789ABCDEFGHIJ"
    activate_receipt_rule_set = true
  }

  assert {
    condition     = length(aws_route53_record.mail) == 4
    error_message = "One MX and three DKIM records must be created in the hosted zone."
  }

  assert {
    condition     = aws_route53_record.mail["mx"].type == "MX" && aws_route53_record.mail["mx"].name == "example.com"
    error_message = "The MX record must be on the domain itself."
  }

  assert {
    condition     = length(aws_ses_active_receipt_rule_set.main) == 1
    error_message = "The rule set must be activated when asked."
  }
}

run "without_customer_kms_key" {
  command = plan

  variables {
    use_customer_kms_key = false
  }

  assert {
    condition     = length(aws_kms_key.mail) == 0
    error_message = "No key may be created."
  }

  assert {
    condition = one([
      for rule in aws_s3_bucket_server_side_encryption_configuration.mail.rule :
      rule.apply_server_side_encryption_by_default[0].sse_algorithm
    ]) == "AES256"
    error_message = "The bucket must still be encrypted, with S3-managed keys."
  }

  assert {
    condition = !contains(
      [for statement in data.aws_iam_policy_document.ingest.statement : statement.sid],
      "Encryption",
    )
    error_message = "The function needs no KMS permissions without a customer key."
  }
}

run "rejects_upper_case_domain" {
  command = plan

  variables {
    domain = "Example.com"
  }

  expect_failures = [var.domain]
}

run "rejects_malformed_mailboxes" {
  command = plan

  variables {
    mailboxes = { "not-an-address" = "me" }
  }

  expect_failures = [var.mailboxes]
}

run "rejects_unsafe_account_ids" {
  command = plan

  variables {
    mailboxes = { "me@example.com" = "../other" }
  }

  expect_failures = [var.mailboxes]
}
