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

  # Ids of the gateway and its integrations, so that a test can say which route goes where.
  override_resource {
    target = aws_apigatewayv2_api.jmap
    values = {
      execution_arn = "arn:aws:execute-api:eu-west-1:123456789012:mockapi"
      api_endpoint  = "https://mockapi.execute-api.eu-west-1.amazonaws.com"
    }
  }

  override_resource {
    target = aws_apigatewayv2_integration.api
    values = {
      id = "jmap-integration"
    }
  }

  override_resource {
    target = aws_apigatewayv2_integration.admin
    values = {
      id = "admin-integration"
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

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock-role"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:eu-west-1:123456789012:function:mock-function"
    }
  }

  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id  = "eu-west-1_Example00"
      arn = "arn:aws:cognito-idp:eu-west-1:123456789012:userpool/eu-west-1_Example00"
    }
  }

  mock_resource "aws_cognito_user_pool_client" {
    defaults = {
      id = "exampleclientid"
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

# The certificate of the sign-in hostname is the one thing made in us-east-1.
mock_provider "aws" {
  alias           = "us_east_1"
  override_during = plan

  override_resource {
    target = module.identity.aws_acm_certificate.auth
    values = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/mock-auth"
      domain_validation_options = [{
        domain_name           = "auth.example.com"
        resource_record_name  = "_validation.auth.example.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_value.acm-validations.aws."
      }]
    }
  }
}

variables {
  region                    = "eu-west-1"
  domain                    = "example.com"
  activate_receipt_rule_set = false
  ingest_bundle             = "tests/fixture-bundle.mjs"
  api_bundle                = "tests/fixture-bundle.mjs"
  events_bundle             = "tests/fixture-bundle.mjs"
  push_bundle               = "tests/fixture-bundle.mjs"
  send_bundle               = "tests/fixture-bundle.mjs"
  admin_bundle              = "tests/fixture-bundle.mjs"
  purge_bundle              = "tests/fixture-bundle.mjs"

  # Every other variable is pinned too: Terraform loads a local terraform.tfvars
  # into tests, and these must not depend on whoever runs them.
  name                 = "mailless"
  route53_zone_id      = null
  api_hostname         = null
  use_customer_kms_key = true
  mail_from_subdomain  = "bounce"
  dmarc_policy         = "quarantine"
  alarm_email          = null

  account_quota_bytes = null

  auth_hostname             = null
  admin_extra_callback_urls = []
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
    ]) == toset(["Logs", "ReadAndRemoveInbound", "TellMissingFromForbidden", "StoreMessages", "Metadata", "ReadDirectory", "DeadLetters", "SendAutomaticReplies", "Encryption"])
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
    condition     = aws_lambda_function.ingest.environment[0].variables["CONFIGURATION_SET"] == "mailless"
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

  # The API checks tokens by what the identity module says about them, not by knowing the provider.
  assert {
    condition = (
      aws_lambda_function.api.environment[0].variables["OIDC_ISSUER"] == "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Example00" &&
      aws_lambda_function.api.environment[0].variables["OIDC_JWKS_URI"] == "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Example00/.well-known/jwks.json" &&
      jsondecode(aws_lambda_function.api.environment[0].variables["OIDC_AUDIENCES"]) == ["exampleclientid"] &&
      aws_lambda_function.api.environment[0].variables["OIDC_AUDIENCE_CLAIM"] == "client_id" &&
      aws_lambda_function.api.environment[0].variables["OIDC_USERNAME_CLAIM"] == "username" &&
      aws_lambda_function.api.environment[0].variables["OIDC_ROLES_CLAIM"] == "cognito:groups" &&
      jsondecode(aws_lambda_function.api.environment[0].variables["OIDC_REQUIRED_CLAIMS"]) == { token_use = "access" }
    )
    error_message = "The API must be told how to check a token: issuer, keys, audience and claims."
  }

  assert {
    condition = (
      output.admin_role == "MAILLESS_ADMIN" &&
      output.admin_client_id == "exampleclientid" &&
      output.user_pool_id == "eu-west-1_Example00"
    )
    error_message = "The admin role, the admin client and the pool must be outputs."
  }

  # Without a zone the sign-in pages are on a hostname Cognito provides.
  assert {
    condition = output.auth == {
      base_url              = "https://mailless-123456789012.auth.eu-west-1.amazoncognito.com"
      authorize_url         = "https://mailless-123456789012.auth.eu-west-1.amazoncognito.com/oauth2/authorize"
      token_url             = "https://mailless-123456789012.auth.eu-west-1.amazoncognito.com/oauth2/token"
      logout_url            = "https://mailless-123456789012.auth.eu-west-1.amazoncognito.com/logout"
      passkey_enrolment_url = "https://mailless-123456789012.auth.eu-west-1.amazoncognito.com/passkeys/add"
    }
    error_message = "The sign-in pages must be an output, with the page for enrolling a passkey."
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

  # Who has a mailbox is in the directory and nowhere else, and the account's own password is not the API's to check.
  assert {
    condition = alltrue([
      for name in ["MAILBOXES", "ACCOUNT_NAMES", "ACCOUNT_SHARES", "ALLOW_PASSWORD_SIGN_IN", "USER_POOL_ID", "USER_POOL_CLIENT_ID"] :
      !contains(keys(aws_lambda_function.api.environment[0].variables), name) &&
      !contains(keys(aws_lambda_function.ingest.environment[0].variables), name)
    ])
    error_message = "Accounts must not be configured through the functions' environment, and the API must not sign anyone in with the pool."
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

  assert {
    condition = (
      output.admin_api_url == "https://mail.example.com/admin/api" &&
      output.admin_url == "https://mail.example.com/admin/"
    )
    error_message = "The admin interface and its API must be reached on the API's own hostname."
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
      toset(keys(aws_cloudwatch_metric_alarm.dead_letters)) == toset(["ingest", "delivery-events", "push", "scheduled-send", "purge"])
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

  # Both functions sign pushes with one key, which only the API may make, and which is no resource of this stack.
  assert {
    condition = (
      aws_lambda_function.api.environment[0].variables["VAPID_PARAMETER"] == "/mailless/vapid-keys" &&
      aws_lambda_function.push.environment[0].variables["VAPID_PARAMETER"] == "/mailless/vapid-keys" &&
      aws_lambda_function.push.environment[0].variables["VAPID_SUBJECT"] == "mailto:postmaster@example.com" &&
      one(data.aws_iam_policy_document.api_push_key.statement).actions == toset(["ssm:GetParameter", "ssm:PutParameter"]) &&
      one(data.aws_iam_policy_document.api_push_key.statement).resources == toset(["arn:aws:ssm:eu-west-1:123456789012:parameter/mailless/vapid-keys"]) &&
      alltrue([
        for statement in data.aws_iam_policy_document.push.statement :
        statement.actions == toset(["ssm:GetParameter"]) && statement.resources == toset(["arn:aws:ssm:eu-west-1:123456789012:parameter/mailless/vapid-keys"])
        if statement.sid == "PushSigningKey"
      ])
    )
    error_message = "The API may make and read the push signing key, the push function may only read it, and neither may touch any other parameter."
  }

  assert {
    condition     = length(aws_lambda_function.push.vpc_config) == 0
    error_message = "The push function must stay outside any VPC: it calls push services named by clients and must not be able to reach private addresses."
  }
}

run "sending_later" {
  command = plan

  # The function that sends held mail may send only as the domain, and read the queue: nothing else new.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.send.statement :
      !contains(statement.resources, "*") && alltrue([for action in statement.actions : !endswith(action, ":*") && action != "*"])
    ])
    error_message = "The send role must not use wildcard actions or resources."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.send.statement :
      one(statement.condition).variable == "ses:FromAddress" && one(statement.condition).values == tolist(["*@example.com"])
      if statement.sid == "SendMail"
    ])
    error_message = "Held mail may only be sent as an address of the domain."
  }

  # The API may make schedules in its own group only, and hand them the scheduler role only.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.api_scheduling.statement :
      !contains(statement.resources, "*") &&
      (statement.sid != "ScheduleLongDelays" || alltrue([for resource in statement.resources : endswith(resource, ":schedule/mailless/*")])) &&
      (statement.sid != "HandOverTheSchedulerRole" || one(statement.condition).values == tolist(["scheduler.amazonaws.com"]))
    ])
    error_message = "The API's scheduling permissions must be limited to this stack's group and role."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.scheduler.statement :
      !contains(statement.resources, "*") && contains(["lambda:InvokeFunction", "sqs:SendMessage"], one(statement.actions))
    ])
    error_message = "A schedule may only wake the send function or leave a dead letter."
  }

  assert {
    condition = (
      aws_lambda_event_source_mapping.send.batch_size == 1 &&
      aws_sqs_queue.send.visibility_timeout_seconds > aws_lambda_function.send.timeout &&
      jsondecode(aws_sqs_queue.send.redrive_policy).maxReceiveCount == 5
    )
    error_message = "A held message must be retried on its own, and set aside when it keeps failing."
  }

  assert {
    condition = (
      aws_lambda_function.api.environment[0].variables["SCHEDULE_GROUP"] == "mailless" &&
      contains(keys(aws_lambda_function.api.environment[0].variables), "SEND_QUEUE_URL")
    )
    error_message = "The API must know where to arrange a later send."
  }
}

run "admin_api" {
  command = plan

  assert {
    condition = toset([
      for statement in data.aws_iam_policy_document.admin.statement : statement.sid
    ]) == toset(["Logs", "Directory", "AppPasswords", "MailUsage", "ManageUsers", "Encryption"])
    error_message = "Unexpected statements in the admin role policy."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.admin.statement :
      !contains(statement.resources, "*") && alltrue([for action in statement.actions : !endswith(action, ":*") && action != "*"])
    ])
    error_message = "The admin role must not use wildcard actions or resources."
  }

  # It changes who has a mailbox. It must not be able to read what is in one, or send as anyone.
  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.admin.statement : [
        for action in statement.actions : !startswith(action, "s3:") && !startswith(action, "ses:")
      ]
    ]))
    error_message = "The admin role must have no access to stored mail or to sending."
  }

  # In the table that also holds mail, only app passwords and the state counters can be reached.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.admin.statement :
      one(statement.condition).test == "ForAllValues:StringLike" &&
      one(statement.condition).variable == "dynamodb:LeadingKeys" &&
      toset(one(statement.condition).values) == toset(["R#*#AppPassword", "L#*#AppPassword", "S#*"]) &&
      !contains(statement.actions, "dynamodb:Scan")
      if statement.sid == "AppPasswords"
    ])
    error_message = "The admin role must reach only app-password partitions of the metadata table, and never scan it."
  }

  # How full a mailbox is can be read, and that is all: the counter, not the mail.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.admin.statement :
      toset(statement.actions) == toset(["dynamodb:GetItem", "dynamodb:BatchGetItem"]) &&
      one(statement.condition).variable == "dynamodb:LeadingKeys" &&
      toset(one(statement.condition).values) == toset(["R#*#Quota"])
      if statement.sid == "MailUsage"
    ])
    error_message = "The admin role may read the usage counter of an account and nothing else of its mail."
  }

  assert {
    condition     = aws_lambda_function.admin.environment[0].variables["QUOTA_OCTETS"] == "0"
    error_message = "Without a quota the admin function must be told there is none."
  }

  assert {
    condition = toset(flatten([
      for statement in data.aws_iam_policy_document.admin.statement : statement.resources
      if length(statement.condition) > 0
    ])) == toset([aws_dynamodb_table.metadata.arn])
    error_message = "Every statement of the admin role on the metadata table must be limited by key."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.admin.statement :
      statement.resources == toset([module.identity.provider.user_pool_arn]) &&
      alltrue([for action in statement.actions : startswith(action, "cognito-idp:")])
      if statement.sid == "ManageUsers"
    ])
    error_message = "Users may be managed in this stack's pool only."
  }

  assert {
    condition = (
      aws_lambda_function.admin.handler == "admin-api.handler" &&
      aws_lambda_function.admin.environment[0].variables["DIRECTORY_TABLE"] == "mailless-directory" &&
      aws_lambda_function.admin.environment[0].variables["TABLE_NAME"] == "mailless-metadata" &&
      aws_lambda_function.admin.environment[0].variables["USER_POOL_ID"] == module.identity.provider.user_pool_id &&
      aws_lambda_function.admin.environment[0].variables["ADMIN_ROLE"] == "MAILLESS_ADMIN" &&
      endswith(aws_lambda_function.admin.environment[0].variables["PASSKEY_ENROLMENT_URL"], "/passkeys/add")
    )
    error_message = "The admin function must know the directory, where app passwords are, the pool, the role and the passkey page."
  }

  # A token issued for a mail client is not one for the admin API, and the other way round.
  assert {
    condition = (
      jsondecode(aws_lambda_function.admin.environment[0].variables["OIDC_AUDIENCES"]) == [module.identity.admin_client_id] &&
      jsondecode(aws_lambda_function.api.environment[0].variables["OIDC_AUDIENCES"]) == [module.identity.jmap_client_id] &&
      aws_lambda_function.admin.environment[0].variables["OIDC_ISSUER"] == module.identity.oidc.issuer &&
      aws_lambda_function.admin.environment[0].variables["OIDC_AUDIENCE_CLAIM"] == "client_id" &&
      aws_lambda_function.admin.environment[0].variables["OIDC_USERNAME_CLAIM"] == "username" &&
      aws_lambda_function.admin.environment[0].variables["OIDC_ROLES_CLAIM"] == "cognito:groups" &&
      jsondecode(aws_lambda_function.admin.environment[0].variables["OIDC_REQUIRED_CLAIMS"]) == { token_use = "access" }
    )
    error_message = "The admin function must accept only access tokens issued for the admin client."
  }

  assert {
    condition = (
      toset(keys(aws_apigatewayv2_route.admin)) == toset(["GET", "POST", "PUT", "PATCH", "DELETE"]) &&
      alltrue([
        for method, route in aws_apigatewayv2_route.admin :
        route.route_key == "${method} /admin/api/{proxy+}" && route.authorization_type == "JWT"
      ]) &&
      aws_apigatewayv2_authorizer.admin.authorizer_type == "JWT" &&
      aws_apigatewayv2_authorizer.admin.identity_sources == toset(["$request.header.Authorization"]) &&
      aws_apigatewayv2_authorizer.admin.jwt_configuration[0].issuer == module.identity.oidc.issuer &&
      aws_apigatewayv2_authorizer.admin.jwt_configuration[0].audience == toset([module.identity.admin_client_id]) &&
      aws_apigatewayv2_integration.admin.payload_format_version == "2.0"
    )
    error_message = "The admin API must be behind a JWT authorizer for the admin client."
  }

  # The pages are public, as the files of any web application are; what they do goes through the API.
  assert {
    condition = (
      toset(keys(aws_apigatewayv2_route.admin_pages)) == toset(["GET /admin", "GET /admin/{proxy+}"]) &&
      alltrue([
        for key, route in aws_apigatewayv2_route.admin_pages :
        route.route_key == key && route.authorization_type == "NONE" && route.authorizer_id == null
      ])
    )
    error_message = "The pages of the admin interface must be readable without a token, and only readable."
  }

  # Every admin route goes to the admin function, and none of them to the one that reads mail.
  assert {
    condition = (
      alltrue([for route in aws_apigatewayv2_route.admin : route.target == "integrations/admin-integration"]) &&
      alltrue([for route in aws_apigatewayv2_route.admin_pages : route.target == "integrations/admin-integration"]) &&
      alltrue([for route in aws_apigatewayv2_route.jmap : route.target == "integrations/jmap-integration"])
    )
    error_message = "The admin routes must all go to the admin integration, and the JMAP routes to their own."
  }

  assert {
    condition = (
      aws_lambda_permission.api_gateway_invoke_admin.source_arn == "arn:aws:execute-api:eu-west-1:123456789012:mockapi/*/*/admin/*" &&
      aws_lambda_permission.api_gateway_invoke_admin_root.source_arn == "arn:aws:execute-api:eu-west-1:123456789012:mockapi/*/GET/admin"
    )
    error_message = "The gateway may call the admin function for /admin and what is under it, and for nothing else."
  }

  # What the pages are told, so that they can send someone to sign in.
  assert {
    condition = (
      aws_lambda_function.admin.environment[0].variables["ADMIN_CLIENT_ID"] == module.identity.admin_client_id &&
      toset(jsondecode(aws_lambda_function.admin.environment[0].variables["AUTH_SCOPES"])) == toset(["openid", "aws.cognito.signin.user.admin"]) &&
      aws_lambda_function.admin.environment[0].variables["AUTH_AUTHORIZE_URL"] == module.identity.hosted.authorize_url &&
      aws_lambda_function.admin.environment[0].variables["AUTH_TOKEN_URL"] == module.identity.hosted.token_url &&
      aws_lambda_function.admin.environment[0].variables["AUTH_LOGOUT_URL"] == module.identity.hosted.logout_url &&
      aws_lambda_function.admin.environment[0].variables["AUTH_ORIGIN"] == module.identity.hosted.base_url &&
      startswith(module.identity.hosted.authorize_url, "${module.identity.hosted.base_url}/")
    )
    error_message = "The pages must be told the admin client, its scopes and the sign-in pages' addresses."
  }

  # The mail endpoints stay as they were: named one by one, with no catch-all and no authorizer of the gateway's.
  assert {
    condition = (
      toset(keys(aws_apigatewayv2_route.jmap)) == toset(["GET /.well-known/jmap", "POST /jmap/api", "POST /jmap/upload/{accountId}", "GET /jmap/download/{proxy+}"]) &&
      alltrue([for route in aws_apigatewayv2_route.jmap : route.authorizer_id == null])
    )
    error_message = "The JMAP routes must not change."
  }

  assert {
    condition     = output.admin_function == "mailless-admin"
    error_message = "The admin function must be an output."
  }
}

run "accounts_can_have_a_quota" {
  command = plan

  variables {
    account_quota_bytes = 5368709120
  }

  assert {
    condition     = aws_lambda_function.api.environment[0].variables["QUOTA_OCTETS"] == "5368709120"
    error_message = "The API must be told the quota."
  }

  assert {
    condition     = aws_lambda_function.admin.environment[0].variables["QUOTA_OCTETS"] == "5368709120"
    error_message = "The admin function must be told the same quota, to show usage against it."
  }
}

run "no_quota_by_default" {
  command = plan

  assert {
    condition     = !contains(keys(aws_lambda_function.api.environment[0].variables), "QUOTA_OCTETS")
    error_message = "Without a quota set, none must be enforced."
  }
}

run "rejects_a_tiny_quota" {
  command = plan

  variables {
    account_quota_bytes = 1000
  }

  expect_failures = [var.account_quota_bytes]
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

  # With a zone the sign-in pages get a hostname of our own.
  assert {
    condition     = output.auth.base_url == "https://auth.example.com" && output.auth.passkey_enrolment_url == "https://auth.example.com/passkeys/add"
    error_message = "The sign-in pages must be on auth.<domain> when the zone is managed here."
  }
}

run "sign_in_hostname_can_be_chosen" {
  command = plan

  variables {
    route53_zone_id = "Z0123456789ABCDEFGHIJ"
    auth_hostname   = "login.example.com"
  }

  assert {
    condition     = output.auth.base_url == "https://login.example.com"
    error_message = "The sign-in pages must be on the hostname asked for."
  }
}

run "rejects_a_malformed_sign_in_hostname" {
  command = plan

  variables {
    auth_hostname = "Auth.Example.com"
  }

  expect_failures = [var.auth_hostname]
}

run "the_admin_interface_can_be_run_locally" {
  command = plan

  variables {
    admin_extra_callback_urls = ["http://localhost:5173/admin/callback", "https://staging.example.com/admin/callback"]
  }
}

run "rejects_sign_in_returning_over_plain_http" {
  command = plan

  variables {
    admin_extra_callback_urls = ["http://admin.example.com/admin/callback"]
  }

  expect_failures = [var.admin_extra_callback_urls]
}

# The runs below look inside the identity module, which a run of the whole
# stack cannot: there, only what the module gives out is visible.

run "identity_closed_sign_up_with_passkeys" {
  command = plan

  module {
    source = "./modules/identity-cognito"
  }

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    account_id     = "123456789012"
    auth_hostname  = "auth.example.com"
    admin_base_url = "https://abc123.execute-api.eu-west-1.amazonaws.com"
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

  # A passkey may replace the password, which stays: it is how a new user gets in to enrol one.
  assert {
    condition     = toset(aws_cognito_user_pool.main.sign_in_policy[0].allowed_first_auth_factors) == toset(["PASSWORD", "WEB_AUTHN"])
    error_message = "People must be able to sign in with a passkey, and still with a password."
  }

  # On a hostname Cognito provides, a passkey can only be bound to that hostname.
  assert {
    condition = (
      aws_cognito_user_pool.main.web_authn_configuration[0].relying_party_id == "mailless-123456789012.auth.eu-west-1.amazoncognito.com" &&
      aws_cognito_user_pool_domain.main.domain == "mailless-123456789012" &&
      aws_cognito_user_pool_domain.main.managed_login_version == 2 &&
      length(aws_acm_certificate.auth) == 0 &&
      length(aws_route53_record.auth) == 0
    )
    error_message = "Without a zone the sign-in pages must be Cognito's own hostname, in the version that enrols passkeys."
  }

  assert {
    condition     = aws_cognito_user_group.admin.name == "MAILLESS_ADMIN"
    error_message = "There must be a group for those who may manage accounts."
  }

  # A browser cannot keep a secret, so the admin interface signs in one way only.
  assert {
    condition = (
      !aws_cognito_user_pool_client.admin.generate_secret &&
      aws_cognito_user_pool_client.admin.allowed_oauth_flows_user_pool_client &&
      aws_cognito_user_pool_client.admin.allowed_oauth_flows == toset(["code"]) &&
      aws_cognito_user_pool_client.admin.allowed_oauth_scopes == toset(["openid", "aws.cognito.signin.user.admin"]) &&
      aws_cognito_user_pool_client.admin.supported_identity_providers == toset(["COGNITO"]) &&
      aws_cognito_user_pool_client.admin.explicit_auth_flows == toset(["ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]) &&
      aws_cognito_user_pool_client.admin.prevent_user_existence_errors == "ENABLED" &&
      aws_cognito_user_pool_client.admin.enable_token_revocation
    )
    error_message = "The admin client must be public, use the code flow only, and ask for the two scopes."
  }

  assert {
    condition = (
      aws_cognito_user_pool_client.admin.callback_urls == toset(["https://abc123.execute-api.eu-west-1.amazonaws.com/admin/callback"]) &&
      aws_cognito_user_pool_client.admin.logout_urls == toset(["https://abc123.execute-api.eu-west-1.amazonaws.com/admin/"])
    )
    error_message = "Sign-in must return to the admin interface and nowhere else."
  }

  assert {
    condition     = aws_cognito_managed_login_branding.admin.use_cognito_provided_values
    error_message = "The sign-in pages need a style for the admin client, or they show nothing."
  }
}

run "identity_on_a_hostname_of_our_own" {
  command = plan

  module {
    source = "./modules/identity-cognito"
  }

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  override_resource {
    target          = aws_acm_certificate.auth
    override_during = plan
    values = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/mock-auth"
      domain_validation_options = [{
        domain_name           = "auth.example.com"
        resource_record_name  = "_validation.auth.example.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_value.acm-validations.aws."
      }]
    }
  }

  variables {
    account_id                = "123456789012"
    route53_zone_id           = "Z0123456789ABCDEFGHIJ"
    auth_hostname             = "auth.example.com"
    admin_base_url            = "https://mail.example.com"
    admin_extra_callback_urls = ["http://localhost:5173/admin/callback"]
  }

  # Bound to the mail domain, a passkey outlives a change of the sign-in hostname.
  assert {
    condition     = aws_cognito_user_pool.main.web_authn_configuration[0].relying_party_id == "example.com"
    error_message = "Passkeys must be bound to the mail domain when the sign-in pages are under it."
  }

  assert {
    condition = (
      aws_cognito_user_pool_domain.main.domain == "auth.example.com" &&
      aws_cognito_user_pool_domain.main.managed_login_version == 2 &&
      aws_acm_certificate.auth[0].domain_name == "auth.example.com" &&
      toset(keys(aws_route53_record.auth)) == toset(["A", "AAAA"])
    )
    error_message = "The sign-in pages must get their hostname, a certificate for it and its DNS records."
  }

  assert {
    condition = aws_cognito_user_pool_client.admin.callback_urls == toset([
      "https://mail.example.com/admin/callback",
      "http://localhost:5173/admin/callback",
    ])
    error_message = "Sign-in must also be able to return to an admin interface run locally."
  }

  assert {
    condition     = output.hosted.passkey_enrolment_url == "https://auth.example.com/passkeys/add"
    error_message = "The page for enrolling a passkey must be on the sign-in hostname."
  }
}

run "identity_sign_in_hostname_on_another_domain" {
  command = plan

  module {
    source = "./modules/identity-cognito"
  }

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  override_resource {
    target          = aws_acm_certificate.auth
    override_during = plan
    values = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/mock-auth"
      domain_validation_options = [{
        domain_name           = "auth.example.org"
        resource_record_name  = "_validation.auth.example.org."
        resource_record_type  = "CNAME"
        resource_record_value = "_value.acm-validations.aws."
      }]
    }
  }

  variables {
    account_id      = "123456789012"
    route53_zone_id = "Z0123456789ABCDEFGHIJ"
    auth_hostname   = "auth.example.org"
    admin_base_url  = "https://mail.example.com"
  }

  # A passkey cannot be bound to a domain its sign-in page is not under.
  assert {
    condition     = aws_cognito_user_pool.main.web_authn_configuration[0].relying_party_id == "auth.example.org"
    error_message = "Passkeys must be bound to the sign-in hostname when it is not under the mail domain."
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

run "the_directory_is_read_by_the_functions_that_handle_mail" {
  command = plan

  assert {
    condition = (
      aws_dynamodb_table.directory.billing_mode == "PAY_PER_REQUEST" &&
      aws_dynamodb_table.directory.hash_key == "pk" &&
      aws_dynamodb_table.directory.range_key == "sk" &&
      aws_dynamodb_table.directory.deletion_protection_enabled &&
      aws_dynamodb_table.directory.point_in_time_recovery[0].enabled
    )
    error_message = "The directory table must be on-demand, keyed pk/sk, protected and recoverable."
  }

  assert {
    condition = (
      aws_lambda_function.api.environment[0].variables["DIRECTORY_TABLE"] == "mailless-directory" &&
      aws_lambda_function.ingest.environment[0].variables["DIRECTORY_TABLE"] == "mailless-directory"
    )
    error_message = "The API and the ingest function must be told where the directory is."
  }

  assert {
    condition = alltrue([
      for statements in [data.aws_iam_policy_document.api.statement, data.aws_iam_policy_document.ingest.statement] :
      anytrue([
        for statement in statements :
        statement.sid == "ReadDirectory" && toset(statement.actions) == toset(["dynamodb:GetItem", "dynamodb:Query"])
      ])
    ])
    error_message = "The functions that handle mail may read the directory and nothing more."
  }

  assert {
    condition     = output.directory_table == "mailless-directory"
    error_message = "The directory table must be an output, for the commands that read it."
  }
}

run "purging_closed_accounts" {
  command = plan

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.purge.statement :
      !contains(statement.resources, "*") && alltrue([for action in statement.actions : !endswith(action, ":*") && action != "*"])
    ])
    error_message = "The purge role must not use wildcard actions or resources."
  }

  # It removes mail. It must not be able to read a message, write one, send, or touch a user.
  assert {
    condition = toset(flatten([
      for statement in data.aws_iam_policy_document.purge.statement : statement.actions
      if !contains(["Logs", "Queue", "Encryption"], statement.sid)
      ])) == toset([
      "s3:DeleteObject", "s3:ListBucket",
      "dynamodb:Query", "dynamodb:BatchWriteItem", "dynamodb:DeleteItem", "dynamodb:GetItem",
    ])
    error_message = "The purge role may list and remove, and nothing else."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.purge.statement :
      one(statement.condition).variable == "s3:prefix" && one(statement.condition).values == tolist(["blobs/*"])
      if statement.sid == "ListBlobs"
    ])
    error_message = "Only stored mail may be listed, not what is waiting to be delivered."
  }

  # One account is never worked on twice at once, and not before the other functions have noticed it is closed.
  assert {
    condition = (
      aws_sqs_queue.purge.fifo_queue &&
      aws_sqs_queue.purge.delay_seconds >= 120 &&
      aws_lambda_event_source_mapping.purge.batch_size == 1 &&
      aws_sqs_queue.purge.visibility_timeout_seconds > aws_lambda_function.purge.timeout &&
      jsondecode(aws_sqs_queue.purge.redrive_policy).maxReceiveCount == 5
    )
    error_message = "A removal must wait, run alone for its account, and be set aside when it keeps failing."
  }

  # The admin function asks; it does not remove.
  assert {
    condition = (
      one(data.aws_iam_policy_document.admin_purge.statement).actions == toset(["sqs:SendMessage"]) &&
      contains(keys(aws_lambda_function.admin.environment[0].variables), "PURGE_QUEUE_URL") &&
      contains(keys(aws_lambda_function.purge.environment[0].variables), "DIRECTORY_TABLE")
    )
    error_message = "The admin function may only ask for a removal, and the purge function must be able to check the directory."
  }
}
