locals {
  download_prefix = "downloads/"

  # A hostname of our own needs a certificate, which is validated through DNS
  # records, so it is only set up when the domain's zone is in Route53.
  api_custom_domain = var.route53_zone_id != null
  api_hostname      = coalesce(var.api_hostname, "mail.${var.domain}")
}

data "archive_file" "api" {
  type        = "zip"
  source_file = var.api_bundle
  output_path = "${path.module}/.build/api.zip"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.name}-api"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "api" {
  name               = "${var.name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }

  statement {
    sid       = "Messages"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.mail.arn}/${local.blob_prefix}*"]
  }

  # Large downloads are written here and fetched by the client through a short-lived signed URL.
  statement {
    sid       = "OffloadedDownloads"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.mail.arn}/${local.download_prefix}*"]
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

  # Sending is allowed only with a From address at this stack's domain, and only
  # through the configuration set that reports what became of each message.
  # The identity is a wildcard because, while an account is in the SES sandbox,
  # AWS also checks this permission against the recipient's verified identity.
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

  # Without this, S3 answers "access denied" for an object that does not exist, and a
  # missing attachment looks like a failure of the service. It reveals object names only.
  statement {
    sid       = "TellMissingFromForbidden"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.mail.arn]
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

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_lambda_function" "api" {
  function_name = "${var.name}-api"
  role          = aws_iam_role.api.arn

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  handler          = "api.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]

  memory_size = 1024
  # API Gateway gives up after 30 seconds.
  timeout = 29

  environment {
    variables = merge(
      {
        TABLE_NAME          = aws_dynamodb_table.metadata.name
        BUCKET              = aws_s3_bucket.mail.id
        BLOB_PREFIX         = local.blob_prefix
        DOWNLOAD_PREFIX     = local.download_prefix
        USER_POOL_ID        = aws_cognito_user_pool.main.id
        USER_POOL_CLIENT_ID = aws_cognito_user_pool_client.jmap.id
        # Decides which addresses each account may send from.
        MAILBOXES         = jsonencode(var.mailboxes)
        ACCOUNT_NAMES     = jsonencode(var.account_names)
        ACCOUNT_SHARES    = jsonencode(var.shared_accounts)
        CONFIGURATION_SET = aws_sesv2_configuration_set.main.configuration_set_name
        # "false" makes mail clients use app passwords; the account password then only works for tokens.
        ALLOW_PASSWORD_SIGN_IN = tostring(var.allow_password_sign_in)
        # What it takes to hold a message and have it sent later.
        SEND_QUEUE_URL             = aws_sqs_queue.send.url
        SCHEDULE_GROUP             = aws_scheduler_schedule_group.send.name
        SEND_FUNCTION_ARN          = aws_lambda_function.send.arn
        SCHEDULER_ROLE_ARN         = aws_iam_role.scheduler.arn
        SEND_DEAD_LETTER_QUEUE_ARN = aws_sqs_queue.send_dead_letters.arn
      },
      # Without a hostname of our own the function uses the host each request arrived on.
      local.api_custom_domain ? { PUBLIC_URL = "https://${local.api_hostname}" } : {},
    )
  }

  depends_on = [
    aws_cloudwatch_log_group.api,
    aws_iam_role_policy.api,
  ]
}

# ------------------------------------------------------------------- HTTP API

resource "aws_apigatewayv2_api" "jmap" {
  name          = var.name
  protocol_type = "HTTP"

  # With a hostname of our own, the generated one is switched off so there is a single way in.
  disable_execute_api_endpoint = local.api_custom_domain
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.jmap.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

# Only the JMAP endpoints are routed; anything else is refused by the gateway
# without running the function.
resource "aws_apigatewayv2_route" "jmap" {
  for_each = toset([
    "GET /.well-known/jmap",
    "POST /jmap/api",
    "POST /jmap/upload/{accountId}",
    "GET /jmap/download/{proxy+}",
  ])

  api_id    = aws_apigatewayv2_api.jmap.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.jmap.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.api_throttle_burst
    throttling_rate_limit  = var.api_throttle_rate
  }

  # No headers, query strings or bodies: nothing here can contain a credential or mail content.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId = "$context.requestId"
      time      = "$context.requestTime"
      sourceIp  = "$context.identity.sourceIp"
      route     = "$context.routeKey"
      status    = "$context.status"
      bytes     = "$context.responseLength"
      latencyMs = "$context.responseLatency"
    })
  }
}

resource "aws_lambda_permission" "api_gateway_invoke_api" {
  statement_id  = "AllowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.jmap.execution_arn}/*/*"
}

# ------------------------------------------------------------ custom hostname

resource "aws_acm_certificate" "api" {
  count = local.api_custom_domain ? 1 : 0

  domain_name       = local.api_hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "api_certificate_validation" {
  for_each = local.api_custom_domain ? {
    for option in aws_acm_certificate.api[0].domain_validation_options :
    option.domain_name => {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 300
  records         = [each.value.value]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api" {
  count = local.api_custom_domain ? 1 : 0

  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = [for record in aws_route53_record.api_certificate_validation : record.fqdn]
}

resource "aws_apigatewayv2_domain_name" "api" {
  count = local.api_custom_domain ? 1 : 0

  domain_name = local.api_hostname

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.api[0].certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "api" {
  count = local.api_custom_domain ? 1 : 0

  api_id      = aws_apigatewayv2_api.jmap.id
  domain_name = aws_apigatewayv2_domain_name.api[0].id
  stage       = aws_apigatewayv2_stage.default.id
}

resource "aws_route53_record" "api" {
  for_each = local.api_custom_domain ? toset(["A", "AAAA"]) : toset([])

  zone_id = var.route53_zone_id
  name    = local.api_hostname
  type    = each.key

  alias {
    name                   = aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

# Lets a mail client find the server from an address alone (RFC 8620, section 2.2).
resource "aws_route53_record" "jmap_discovery" {
  count = local.api_custom_domain ? 1 : 0

  zone_id = var.route53_zone_id
  name    = "_jmap._tcp.${var.domain}"
  type    = "SRV"
  ttl     = 300
  records = ["0 1 443 ${local.api_hostname}"]
}
