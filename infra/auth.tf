# Who may sign in. Everything about the identity provider is in one module, and
# the rest of the stack only reads its outputs: signing in with another
# provider is another module here that gives the same outputs.

locals {
  # Where the admin interface is served: next to the JMAP API.
  admin_base_url = local.api_custom_domain ? "https://${local.api_hostname}" : aws_apigatewayv2_api.jmap.api_endpoint
}

module "identity" {
  source = "./modules/identity-cognito"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name       = var.name
  region     = var.region
  account_id = local.account_id
  domain     = var.domain

  route53_zone_id           = var.route53_zone_id
  auth_hostname             = coalesce(var.auth_hostname, "auth.${var.domain}")
  admin_base_url            = local.admin_base_url
  admin_extra_callback_urls = var.admin_extra_callback_urls
}

# These were in this file before identity became a module. They are the same
# user pool and client: nothing is made again.
moved {
  from = aws_cognito_user_pool.main
  to   = module.identity.aws_cognito_user_pool.main
}

moved {
  from = aws_cognito_user_pool_client.jmap
  to   = module.identity.aws_cognito_user_pool_client.jmap
}
