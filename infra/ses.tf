resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

locals {
  dkim_tokens = aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens

  dns_records = merge(
    {
      mx = {
        name  = var.domain
        type  = "MX"
        value = "10 inbound-smtp.${var.region}.amazonaws.com"
      }
    },
    {
      # DKIM always has three tokens; indexing keeps the keys known before the identity exists.
      for index in range(3) : "dkim${index}" => {
        name  = "${local.dkim_tokens[index]}._domainkey.${var.domain}"
        type  = "CNAME"
        value = "${local.dkim_tokens[index]}.dkim.amazonses.com"
      }
    },
  )
}

resource "aws_route53_record" "mail" {
  for_each = var.route53_zone_id == null ? {} : local.dns_records

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 300
  records = [each.value.value]
}

resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = local.rule_set_name
}

resource "aws_ses_receipt_rule" "inbound" {
  name          = local.rule_name
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  recipients    = [var.domain]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"

  # Order matters: the message must be in S3 before the function is told about it.
  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.mail.id
    object_key_prefix = local.inbound_prefix
  }

  lambda_action {
    position        = 2
    function_arn    = aws_lambda_function.ingest.arn
    invocation_type = "Event"
  }

  depends_on = [
    aws_s3_bucket_policy.mail,
    aws_lambda_permission.ses_invoke_ingest,
  ]
}

resource "aws_ses_active_receipt_rule_set" "main" {
  count = var.activate_receipt_rule_set ? 1 : 0

  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name

  depends_on = [aws_ses_receipt_rule.inbound]
}
