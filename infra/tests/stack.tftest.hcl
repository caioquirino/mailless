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
      arn = "arn:aws:ses:eu-west-1:123456789012:identity/example.com"
      dkim_signing_attributes = {
        tokens = ["tokena", "tokenb", "tokenc"]
      }
    }
  }

  # The DNS records a certificate asks for are only known to AWS; give the plan something to iterate.
  override_resource {
    target = aws_acm_certificate.api
    values = {
      arn = "arn:aws:acm:eu-west-1:123456789012:certificate/mock"
      domain_validation_options = [{
        domain_name           = "mail.example.com"
        resource_record_name  = "_validation.mail.example.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_value.acm-validations.aws."
      }]
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
      arn        = "arn:aws:dynamodb:eu-west-1:123456789012:table/mock-table"
      stream_arn = "arn:aws:dynamodb:eu-west-1:123456789012:table/mock-table/stream/2026-10-07T00:00:00.000"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:eu-west-1:123456789012:mock-topic"
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
  api_bundle                = "tests/fixture-bundle.mjs"
  events_bundle             = "tests/fixture-bundle.mjs"
  push_bundle               = "tests/fixture-bundle.mjs"

  # Every other variable is pinned too: Terraform loads a local terraform.tfvars
  # into tests, and these must not depend on whoever runs them.
  name                 = "mailless"
  route53_zone_id      = null
  api_hostname         = null
  use_customer_kms_key = true
  mail_from_subdomain  = "bounce"
  dmarc_policy         = "quarantine"
  alarm_email          = null

  allow_password_sign_in = true
  account_names          = { me = "Me Myself" }
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
      length(output.dns_records) == 7 &&
      output.dns_records["dkim0"].name == "tokena._domainkey.example.com" &&
      output.dns_records["dkim2"].value == "tokenc.dkim.amazonses.com"
    )
    error_message = "There must be the inbound MX, three DKIM, two MAIL FROM and one DMARC record."
  }

  assert {
    condition = (
      aws_sesv2_email_identity_mail_from_attributes.domain.mail_from_domain == "bounce.example.com" &&
      output.dns_records["mail_from_mx"] == { name = "bounce.example.com", type = "MX", value = "10 feedback-smtp.eu-west-1.amazonses.com" } &&
      output.dns_records["mail_from_spf"] == { name = "bounce.example.com", type = "TXT", value = "v=spf1 include:amazonses.com ~all" } &&
      output.dns_records["dmarc"] == { name = "_dmarc.example.com", type = "TXT", value = "v=DMARC1; p=quarantine" }
    )
    error_message = "Sender authentication records must be on the bounce subdomain and _dmarc, never on the domain's own SPF."
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
    ]) == toset(["Logs", "ReadAndRemoveInbound", "TellMissingFromForbidden", "StoreMessages", "Metadata", "DeadLetters", "SendAutomaticReplies", "Encryption"])
    error_message = "Unexpected statements in the ingest role policy."
  }

  # Vacation responses are the only mail the ingest function sends, and only as this domain.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.ingest.statement :
      length(statement.condition) == 1 &&
      one(statement.condition).variable == "ses:FromAddress" &&
      one(statement.condition).values == tolist(["*@example.com"])
      if statement.sid == "SendAutomaticReplies"
    ])
    error_message = "The ingest function may only send as an address of the domain."
  }

  assert {
    condition = (
      aws_lambda_function.ingest.environment[0].variables["CONFIGURATION_SET"] == "mailless" &&
      jsondecode(aws_lambda_function.ingest.environment[0].variables["ACCOUNT_NAMES"]) != null
    )
    error_message = "Automatic replies must go through the configuration set, which suppresses bounced addresses."
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

run "api_and_sign_in" {
  command = plan

  assert {
    condition     = toset(keys(aws_cognito_user.account)) == toset(["catchall", "me"])
    error_message = "There must be one user per distinct account id."
  }

  assert {
    condition = (
      aws_cognito_user_pool.main.admin_create_user_config[0].allow_admin_create_user_only &&
      aws_cognito_user_pool.main.deletion_protection == "ACTIVE" &&
      aws_cognito_user_pool.main.password_policy[0].minimum_length >= 14
    )
    error_message = "Sign-up must be closed, the pool protected, and passwords long."
  }

  assert {
    condition = (
      !aws_cognito_user_pool_client.jmap.generate_secret &&
      aws_cognito_user_pool_client.jmap.prevent_user_existence_errors == "ENABLED" &&
      aws_cognito_user_pool_client.jmap.explicit_auth_flows == toset(["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"])
    )
    error_message = "Unexpected app client configuration."
  }

  assert {
    condition = toset(keys(aws_apigatewayv2_route.jmap)) == toset([
      "GET /.well-known/jmap",
      "GET /jmap/download/{proxy+}",
      "POST /jmap/api",
      "POST /jmap/upload/{accountId}",
    ])
    error_message = "Only the JMAP endpoints may be routed."
  }

  assert {
    condition     = aws_apigatewayv2_stage.default.default_route_settings[0].throttling_rate_limit == 20
    error_message = "The API must be throttled."
  }

  # Without a hosted zone there is no hostname of our own, and the generated endpoint stays on.
  assert {
    condition = (
      length(aws_acm_certificate.api) == 0 &&
      length(aws_apigatewayv2_domain_name.api) == 0 &&
      length(aws_route53_record.api) == 0 &&
      !aws_apigatewayv2_api.jmap.disable_execute_api_endpoint &&
      !contains(keys(aws_lambda_function.api.environment[0].variables), "PUBLIC_URL")
    )
    error_message = "No custom hostname may be set up without a hosted zone."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.api.statement :
      !contains(statement.resources, "*") && alltrue([for action in statement.actions : !endswith(action, ":*") && action != "*"])
    ])
    error_message = "The API role must not use wildcard actions or resources."
  }

  # Sending is limited by the From address, not by the identity: in the SES sandbox the
  # recipient's identity is checked too, so the identity has to be a wildcard.
  assert {
    condition = one([
      for statement in data.aws_iam_policy_document.api.statement :
      [for condition in statement.condition : "${condition.test} ${condition.variable} ${join(",", condition.values)}"]
      if statement.sid == "SendMail"
    ]) == ["StringLike ses:FromAddress *@example.com"]
    error_message = "The API may send only with a From address at the stack's own domain."
  }

  assert {
    condition = one([
      for statement in data.aws_iam_policy_document.api.statement : statement.resources
      if statement.sid == "SendMail"
      ]) == toset([
      "arn:aws:ses:eu-west-1:123456789012:identity/*",
      "arn:aws:ses:eu-west-1:123456789012:configuration-set/mailless",
    ])
    error_message = "Sending must go through this stack's configuration set."
  }

  assert {
    condition     = aws_lambda_function.api.environment[0].variables["ACCOUNT_NAMES"] == jsonencode({ me = "Me Myself" })
    error_message = "The API needs the display names to put a sender name on outgoing mail."
  }

  assert {
    condition     = aws_lambda_function.api.environment[0].variables["ALLOW_PASSWORD_SIGN_IN"] == "true"
    error_message = "Account passwords are accepted unless turned off."
  }

  assert {
    condition     = aws_lambda_function.api.environment[0].variables["MAILBOXES"] == jsonencode(var.mailboxes)
    error_message = "The API needs the mailbox map to decide who may send from which address."
  }

  # The API reads and writes mailbox content but has no business in the inbound queue.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.api.statement :
      alltrue([for resource in statement.resources : !strcontains(resource, "/inbound/")])
    ])
    error_message = "The API role must not reach inbound mail."
  }
}

run "api_on_its_own_hostname" {
  command = plan

  variables {
    route53_zone_id = "Z0123456789ABCDEFGHIJ"
  }

  assert {
    condition = (
      aws_acm_certificate.api[0].domain_name == "mail.example.com" &&
      aws_apigatewayv2_domain_name.api[0].domain_name == "mail.example.com" &&
      one(aws_apigatewayv2_domain_name.api[0].domain_name_configuration).security_policy == "TLS_1_2"
    )
    error_message = "The API must be served on mail.<domain> with TLS 1.2 or newer."
  }

  assert {
    condition = (
      aws_apigatewayv2_api.jmap.disable_execute_api_endpoint &&
      aws_lambda_function.api.environment[0].variables["PUBLIC_URL"] == "https://mail.example.com" &&
      output.api_url == "https://mail.example.com"
    )
    error_message = "With its own hostname, the API must advertise it and close the generated endpoint."
  }

  assert {
    condition = (
      toset(keys(aws_route53_record.api)) == toset(["A", "AAAA"]) &&
      aws_route53_record.jmap_discovery[0].name == "_jmap._tcp.example.com" &&
      aws_route53_record.jmap_discovery[0].records == toset(["0 1 443 mail.example.com"])
    )
    error_message = "The hostname and the JMAP discovery record must be published."
  }
}

run "api_hostname_can_be_chosen" {
  command = plan

  variables {
    route53_zone_id = "Z0123456789ABCDEFGHIJ"
    api_hostname    = "jmap.example.com"
  }

  assert {
    condition     = output.jmap_session_url == "https://jmap.example.com/.well-known/jmap"
    error_message = "A chosen hostname must be used throughout."
  }
}

run "password_sign_in_can_be_turned_off" {
  command = plan

  variables {
    allow_password_sign_in = false
  }

  assert {
    condition     = aws_lambda_function.api.environment[0].variables["ALLOW_PASSWORD_SIGN_IN"] == "false"
    error_message = "The API must be told not to accept account passwords."
  }
}

run "delivery_reporting" {
  command = plan

  assert {
    condition = (
      toset(aws_sesv2_configuration_set.main.suppression_options[0].suppressed_reasons) == toset(["BOUNCE", "COMPLAINT"]) &&
      aws_sesv2_configuration_set.main.reputation_options[0].reputation_metrics_enabled &&
      aws_lambda_function.api.environment[0].variables["CONFIGURATION_SET"] == "mailless"
    )
    error_message = "Mail must be sent through a configuration set that suppresses bounced and complaining addresses."
  }

  assert {
    condition = toset(one(aws_sesv2_configuration_set_event_destination.delivery.event_destination).matching_event_types) == toset([
      "BOUNCE", "COMPLAINT", "DELIVERY", "DELIVERY_DELAY", "REJECT",
    ])
    error_message = "Bounces, complaints, deliveries, delays and rejections must all be reported."
  }

  # Only SES, and only for this stack's configuration set, may publish delivery events.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.delivery_events_topic.statement :
      toset([for condition in statement.condition : condition.variable]) == toset(["aws:SourceAccount", "aws:SourceArn"])
    ])
    error_message = "Publishing to the delivery events topic must be tied to this account and configuration set."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.events.statement :
      !contains(statement.resources, "*") && alltrue([for action in statement.actions : !endswith(action, ":*") && action != "*" && !startswith(action, "s3:")])
    ])
    error_message = "The delivery events role must have no wildcards and no access to mail content."
  }

  assert {
    condition = (
      toset(keys(aws_cloudwatch_metric_alarm.reputation)) == toset(["bounce-rate", "complaint-rate"]) &&
      aws_cloudwatch_metric_alarm.reputation["bounce-rate"].threshold < 0.05 &&
      aws_cloudwatch_metric_alarm.reputation["complaint-rate"].threshold < 0.001 &&
      toset(keys(aws_cloudwatch_metric_alarm.dead_letters)) == toset(["ingest", "delivery-events", "push"])
    )
    error_message = "Alarms must fire before SES's own review thresholds, and on any unprocessed message."
  }

  assert {
    condition     = length(aws_sns_topic_subscription.alarm_email) == 0
    error_message = "Nobody is emailed unless an alarm address is given."
  }
}

run "push_notifications" {
  command = plan

  assert {
    condition = (
      aws_dynamodb_table.metadata.stream_enabled &&
      aws_dynamodb_table.metadata.stream_view_type == "KEYS_ONLY"
    )
    error_message = "The table's stream must carry keys only, never mail metadata."
  }

  assert {
    condition = (
      jsondecode(one(one(aws_lambda_event_source_mapping.push.filter_criteria).filter).pattern) == {
        eventName = ["INSERT", "MODIFY"]
        dynamodb  = { Keys = { pk = { S = [{ prefix = "S#" }] } } }
      }
    )
    error_message = "Only state changes may invoke the push function."
  }

  assert {
    condition = (
      aws_lambda_event_source_mapping.push.maximum_retry_attempts == 2 &&
      aws_lambda_event_source_mapping.push.maximum_record_age_in_seconds <= 600 &&
      one(one(aws_lambda_event_source_mapping.push.destination_config).on_failure).destination_arn == aws_sqs_queue.push_dead_letters.arn
    )
    error_message = "A batch that keeps failing must be set aside quickly instead of holding up later changes."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.push.statement :
      !contains(statement.resources, "*") && alltrue([
        for action in statement.actions :
        !endswith(action, ":*") && action != "*" && !startswith(action, "s3:") && !startswith(action, "ses:")
      ])
    ])
    error_message = "The push role must have no wildcards, no access to mail content and no way to send mail."
  }

  assert {
    condition     = length(aws_lambda_function.push.vpc_config) == 0
    error_message = "The push function must stay outside any VPC: it calls push services named by clients and must not be able to reach private addresses."
  }
}

run "alarms_can_email_someone" {
  command = plan

  variables {
    alarm_email = "ops@example.com"
  }

  assert {
    condition = (
      length(aws_sns_topic_subscription.alarm_email) == 1 &&
      aws_sns_topic_subscription.alarm_email[0].endpoint == "ops@example.com"
    )
    error_message = "The alarm address must be subscribed."
  }
}

run "without_dmarc" {
  command = plan

  variables {
    dmarc_policy = null
  }

  assert {
    condition     = !contains(keys(output.dns_records), "dmarc") && length(output.dns_records) == 6
    error_message = "No DMARC record may be published when the policy is null."
  }
}

run "rejects_unknown_dmarc_policy" {
  command = plan

  variables {
    dmarc_policy = "strict"
  }

  expect_failures = [var.dmarc_policy]
}

run "with_hosted_zone_and_activation" {
  command = plan

  variables {
    route53_zone_id           = "Z0123456789ABCDEFGHIJ"
    activate_receipt_rule_set = true
  }

  assert {
    condition     = length(aws_route53_record.mail) == 7
    error_message = "Every mail DNS record must be created in the hosted zone."
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
