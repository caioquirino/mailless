# What the rest of the stack knows about identity. A module for another
# provider (Keycloak, say) gives the same outputs, and nothing outside this
# directory names Cognito except through `provider`.
#
#   oidc             how a token is checked: where it comes from and which
#                    claims say who it is for, whose it is and what roles they have
#   jmap_client_id   the client mail apps sign in to
#   admin_client_id  the client the admin interface signs in to
#   admin_scopes     the scopes the admin interface asks for when it signs someone in
#   hosted           the provider's own pages: sign-in, sign-out, passkey enrolment
#   provider         what the admin API needs to manage users with this provider
#   admin_role       the role whose members may manage accounts
#   users            the sign-in names that exist

output "oidc" {
  value = {
    issuer   = local.issuer
    jwks_uri = "${local.issuer}/.well-known/jwks.json"
    # A Cognito access token names its client in `client_id` and has no `aud`.
    audience_claim  = "client_id"
    username_claim  = "username"
    roles_claim     = "cognito:groups"
    required_claims = { token_use = "access" }
  }
}

output "jmap_client_id" {
  value = aws_cognito_user_pool_client.jmap.id
}

output "admin_client_id" {
  value = aws_cognito_user_pool_client.admin.id
}

output "admin_scopes" {
  value = local.admin_scopes
}

output "hosted" {
  value = {
    base_url      = local.base_url
    authorize_url = "${local.base_url}/oauth2/authorize"
    token_url     = "${local.base_url}/oauth2/token"
    logout_url    = "${local.base_url}/logout"
    # Where a signed-in user adds a passkey. Nobody is sent there unasked.
    passkey_enrolment_url = "${local.base_url}/passkeys/add"
  }
}

output "provider" {
  value = {
    type          = "cognito"
    user_pool_id  = aws_cognito_user_pool.main.id
    user_pool_arn = aws_cognito_user_pool.main.arn
    region        = var.region
  }
}

output "admin_role" {
  value = aws_cognito_user_group.admin.name
}

output "users" {
  value = sort(keys(aws_cognito_user.account))
}
