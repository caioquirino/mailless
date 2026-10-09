resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# Outgoing mail uses a subdomain of ours as its envelope sender, so that SPF
# passes for our own domain and not only for amazonses.com. The records live on
# the subdomain and leave any SPF record on the domain itself alone.
resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

locals {
  dkim_tokens      = aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens
  mail_from_domain = "${var.mail_from_subdomain}.${var.domain}"

  dns_records = merge(
    {
      mx = {
        name  = var.domain
        type  = "MX"
        value = "10 inbound-smtp.${var.region}.amazonaws.com"
      }
      mail_from_mx = {
        name  = local.mail_from_domain
        type  = "MX"
        value = "10 feedback-smtp.${var.region}.amazonses.com"
      }
      mail_from_spf = {
        name  = local.mail_from_domain
        type  = "TXT"
        value = "v=spf1 include:amazonses.com ~all"
      }
    },
    # Tells receivers what to do with mail that claims to be from the domain but fails
    # authentication. Everything this stack sends is DKIM-signed, so it passes.
    var.dmarc_policy == null ? {} : {
      dmarc = {
        name  = "_dmarc.${var.domain}"
        type  = "TXT"
        value = "v=DMARC1; p=${var.dmarc_policy}"
      }
    },
    # Where the domain's logo is, for mail programs that show one. No certificate goes with it (a=).
    local.logo_published ? {
      bimi = {
        name  = "default._bimi.${var.domain}"
        type  = "TXT"
        value = "v=BIMI1; l=${local.logo_url}; a=;"
      }
    } : {},
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
