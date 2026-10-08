# Who may sign in, with Amazon Cognito. Users are created here, one per account
# id; nobody can sign themselves up. A password is set separately with
# `pnpm infra password <account>` so that it never passes through Terraform or
# its state.

locals {
  # What the admin interface may ask for. The second lets a user change their
  # own password and remove their own passkeys.
  admin_scopes = ["openid", "aws.cognito.signin.user.admin"]

  # A hostname of our own needs a certificate, which is validated through DNS
  # records, so it is only set up when the domain's zone is in Route53.
  custom_domain = var.route53_zone_id != null

  prefix          = "${var.name}-${var.account_id}"
  prefix_hostname = "${local.prefix}.auth.${var.region}.amazoncognito.com"
  hostname        = local.custom_domain ? var.auth_hostname : local.prefix_hostname

  # What a passkey is bound to. With a hostname of our own under the mail
  # domain it is the mail domain itself, so that passkeys outlive a change of
  # that hostname. On a hostname Cognito provides it can only be that hostname:
  # moving to one of our own later means every passkey is enrolled again.
  relying_party_id = (
    local.custom_domain
    ? (endswith(var.auth_hostname, ".${var.domain}") ? var.domain : var.auth_hostname)
    : local.prefix_hostname
  )

  issuer   = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  base_url = "https://${local.hostname}"
}

resource "aws_cognito_user_pool" "main" {
  name                = var.name
  deletion_protection = "ACTIVE"
  mfa_configuration   = "OFF"

  username_configuration {
    case_sensitive = false
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }

  # Length over composition rules: a long passphrase is both stronger and easier to type.
  password_policy {
    minimum_length                   = 14
    require_lowercase                = false
    require_uppercase                = false
    require_numbers                  = false
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  # A passkey may take the place of the password once someone has enrolled one.
  # The password stays allowed: it is how a new user gets in to enrol it.
  sign_in_policy {
    allowed_first_auth_factors = ["PASSWORD", "WEB_AUTHN"]
  }

  web_authn_configuration {
    relying_party_id  = local.relying_party_id
    user_verification = "preferred"
  }
}

resource "aws_cognito_user_pool_client" "jmap" {
  name         = "${var.name}-jmap"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  # USER_PASSWORD_AUTH lets a program trade a username and password for a
  # token directly with the pool. The API itself never does: mail clients that
  # only speak HTTP Basic authentication use app passwords.
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

# Users were once made here, one per account in the configuration. They are
# made in the admin interface now. Those that exist stay as they are: this
# only stops Terraform from keeping track of them.
removed {
  from = aws_cognito_user.account

  lifecycle {
    destroy = false
  }
}

# ------------------------------------------------------------- admin interface

# Members may manage accounts in the admin interface. Membership is in the
# access token, so the admin API can check it without asking anyone.
resource "aws_cognito_user_group" "admin" {
  name         = var.admin_role
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "May manage accounts in the admin interface."
}

# The admin interface runs in a browser, which cannot keep a secret: it signs
# in through the sign-in pages with the authorization code flow and PKCE, and
# no other way.
resource "aws_cognito_user_pool_client" "admin" {
  name         = "${var.name}-admin"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = local.admin_scopes
  supported_identity_providers         = ["COGNITO"]

  callback_urls = concat(["${var.admin_base_url}/admin/callback"], var.admin_extra_callback_urls)
  logout_urls   = ["${var.admin_base_url}/admin/"]

  # USER_AUTH is what lets the sign-in pages offer a passkey next to the password.
  explicit_auth_flows = [
    "ALLOW_USER_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  # Shorter than for a mail client: this is a session someone sits at, and it
  # can change accounts.
  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 1

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

# ------------------------------------------------------------- sign-in pages

# Cognito's own pages, where people sign in and enrol a passkey. Version 2
# ("managed login") is the one that has the page for enrolling a passkey.
resource "aws_cognito_user_pool_domain" "main" {
  domain                = local.custom_domain ? var.auth_hostname : local.prefix
  user_pool_id          = aws_cognito_user_pool.main.id
  certificate_arn       = local.custom_domain ? aws_acm_certificate_validation.auth[0].certificate_arn : null
  managed_login_version = 2
}

# The pages show nothing until a client has a style; this is Cognito's default look.
resource "aws_cognito_managed_login_branding" "admin" {
  user_pool_id                = aws_cognito_user_pool.main.id
  client_id                   = aws_cognito_user_pool_client.admin.id
  use_cognito_provided_values = true

  depends_on = [aws_cognito_user_pool_domain.main]
}

# Cognito serves a hostname of our own through CloudFront, so its certificate
# has to be in us-east-1. Cognito also refuses the hostname unless its parent
# domain (example.com for auth.example.com) has an A record of its own.
resource "aws_acm_certificate" "auth" {
  count    = local.custom_domain ? 1 : 0
  provider = aws.us_east_1

  domain_name       = var.auth_hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "auth_certificate_validation" {
  for_each = local.custom_domain ? {
    for option in aws_acm_certificate.auth[0].domain_validation_options :
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

resource "aws_acm_certificate_validation" "auth" {
  count    = local.custom_domain ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.auth[0].arn
  validation_record_fqdns = [for record in aws_route53_record.auth_certificate_validation : record.fqdn]
}

resource "aws_route53_record" "auth" {
  for_each = local.custom_domain ? toset(["A", "AAAA"]) : toset([])

  zone_id = var.route53_zone_id
  name    = var.auth_hostname
  type    = each.key

  alias {
    name                   = aws_cognito_user_pool_domain.main.cloudfront_distribution
    zone_id                = aws_cognito_user_pool_domain.main.cloudfront_distribution_zone_id
    evaluate_target_health = false
  }
}
