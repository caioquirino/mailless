# Who may sign in. Users are created here, one per account id used in
# var.mailboxes; nobody can sign themselves up. A password is set separately
# with `pnpm infra password <account>` so that it never passes through
# Terraform or its state.

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
}

resource "aws_cognito_user_pool_client" "jmap" {
  name         = "${var.name}-jmap"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  # USER_PASSWORD_AUTH lets the API check a username and password on behalf of
  # mail clients that only speak HTTP Basic authentication.
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

resource "aws_cognito_user" "account" {
  for_each = toset(values(var.mailboxes))

  user_pool_id = aws_cognito_user_pool.main.id
  # The username is the account id: the API uses it to pick the mailbox.
  username       = each.key
  message_action = "SUPPRESS"
}
