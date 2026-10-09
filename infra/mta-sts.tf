# Mail on its way to the domain, kept from being read or diverted.
#
# Servers that send mail try TLS and, when it fails, mostly send in the clear
# all the same: whoever sits between them and us only has to make it fail.
# MTA-STS (RFC 8461) is the domain saying that it is not to be done: mail for
# it goes over TLS, to the servers named here, or it waits. A record in the
# DNS says there is a policy; the policy itself is a small file on
# https://mta-sts.<domain>, which is why it needs the zone: a certificate for
# that name is validated through it.
#
# TLS reporting (RFC 8460) is the other half: senders say, once a day, how
# delivery over TLS went. It is asked for only when there is somewhere to send
# the reports.

locals {
  mta_sts_published = var.route53_zone_id != null && var.mta_sts_mode != null
  mta_sts_hostname  = "mta-sts.${var.domain}"
  inbound_mx        = "inbound-smtp.${var.region}.amazonaws.com"

  # Lines end as the RFC asks. A week in force, a day while only being tried:
  # how long a sender goes on holding to a policy that has since changed.
  mta_sts_policy = join("\r\n", [
    "version: STSv1",
    "mode: ${coalesce(var.mta_sts_mode, "none")}",
    "mx: ${local.inbound_mx}",
    "max_age: ${var.mta_sts_mode == "enforce" ? 604800 : 86400}",
    "",
  ])

  transport_dns_records = merge(
    # Changes whenever the policy does, which is what tells senders to fetch it again.
    local.mta_sts_published ? {
      mta_sts = {
        name  = "_mta-sts.${var.domain}"
        type  = "TXT"
        value = "v=STSv1; id=${substr(sha256(local.mta_sts_policy), 0, 24)}"
      }
    } : {},
    var.mail_report_address == null ? {} : {
      tls_reports = {
        name  = "_smtp._tls.${var.domain}"
        type  = "TXT"
        value = "v=TLSRPTv1; rua=mailto:${var.mail_report_address}"
      }
    },
  )
}

data "archive_file" "mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  type        = "zip"
  output_path = "${path.module}/.build/mta-sts.zip"

  source {
    filename = "policy.txt"
    content  = local.mta_sts_policy
  }

  # Hands out the one file it was packed with, as text.
  source {
    filename = "index.mjs"
    content  = <<-JS
      import { readFileSync } from 'node:fs';

      const policy = readFileSync(new URL('./policy.txt', import.meta.url), 'utf8');

      export const handler = async () => ({
        statusCode: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=3600',
          'x-content-type-options': 'nosniff',
        },
        body: policy,
      });
    JS
  }
}

resource "aws_cloudwatch_log_group" "mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  name              = "/aws/lambda/${var.name}-mta-sts"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  name               = "${var.name}-mta-sts"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.mta_sts[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  name   = "mta-sts"
  role   = aws_iam_role.mta_sts[0].id
  policy = data.aws_iam_policy_document.mta_sts[0].json
}

# It can read its own file and write its own log, and nothing else at all.
resource "aws_lambda_function" "mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  function_name = "${var.name}-mta-sts"
  role          = aws_iam_role.mta_sts[0].arn

  filename         = data.archive_file.mta_sts[0].output_path
  source_code_hash = data.archive_file.mta_sts[0].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]

  memory_size = 128
  timeout     = 5

  depends_on = [
    aws_cloudwatch_log_group.mta_sts,
    aws_iam_role_policy.mta_sts,
  ]
}

resource "aws_apigatewayv2_integration" "mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  api_id                 = aws_apigatewayv2_api.jmap.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.mta_sts[0].invoke_arn
  payload_format_version = "2.0"
}

# Public, as a policy is: every server with mail for the domain fetches it.
resource "aws_apigatewayv2_route" "mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  api_id    = aws_apigatewayv2_api.jmap.id
  route_key = "GET /.well-known/mta-sts.txt"
  target    = "integrations/${aws_apigatewayv2_integration.mta_sts[0].id}"

  authorization_type = "NONE"
}

resource "aws_lambda_permission" "api_gateway_invoke_mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  statement_id  = "AllowHttpApiMtaSts"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.mta_sts[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.jmap.execution_arn}/*/GET/.well-known/mta-sts.txt"
}

# The name the policy has to be fetched from, which is not ours to choose.
resource "aws_acm_certificate" "mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  domain_name       = local.mta_sts_hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "mta_sts_certificate_validation" {
  for_each = local.mta_sts_published ? {
    for option in aws_acm_certificate.mta_sts[0].domain_validation_options :
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

resource "aws_acm_certificate_validation" "mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  certificate_arn         = aws_acm_certificate.mta_sts[0].arn
  validation_record_fqdns = [for record in aws_route53_record.mta_sts_certificate_validation : record.fqdn]
}

resource "aws_apigatewayv2_domain_name" "mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  domain_name = local.mta_sts_hostname

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.mta_sts[0].certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "mta_sts" {
  count = local.mta_sts_published ? 1 : 0

  api_id      = aws_apigatewayv2_api.jmap.id
  domain_name = aws_apigatewayv2_domain_name.mta_sts[0].id
  stage       = aws_apigatewayv2_stage.default.id
}

resource "aws_route53_record" "mta_sts" {
  for_each = local.mta_sts_published ? toset(["A", "AAAA"]) : toset([])

  zone_id = var.route53_zone_id
  name    = local.mta_sts_hostname
  type    = each.key

  alias {
    name                   = aws_apigatewayv2_domain_name.mta_sts[0].domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.mta_sts[0].domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
