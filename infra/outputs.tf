output "dns_records" {
  description = "Records the domain needs. Created automatically when route53_zone_id is set; otherwise add them at your DNS provider."
  value       = local.dns_records
}

output "logo_url" {
  description = "Where the domain's logo is published, when one is."
  value       = local.logo_published ? local.logo_url : null
}

output "dns_records_managed" {
  description = "Whether this stack created the DNS records."
  value       = var.route53_zone_id != null
}

output "mail_bucket" {
  value = aws_s3_bucket.mail.id
}

output "metadata_table" {
  value = aws_dynamodb_table.metadata.name
}

output "directory_table" {
  description = "Who has a mailbox. Filled from terraform.tfvars with `pnpm infra directory seed`."
  value       = aws_dynamodb_table.directory.name
}

output "ingest_function" {
  value = aws_lambda_function.ingest.function_name
}

output "ingest_dead_letter_queue" {
  description = "Deliveries that failed after all retries. It should stay empty."
  value       = aws_sqs_queue.ingest_dead_letters.url
}

output "events_dead_letter_queue" {
  description = "Delivery reports that could not be processed. It should stay empty."
  value       = aws_sqs_queue.events_dead_letters.url
}

output "push_dead_letter_queue" {
  description = "Batches of changes that could not be pushed to mail apps. It should stay empty."
  value       = aws_sqs_queue.push_dead_letters.url
}

output "send_dead_letter_queue" {
  description = "Held messages that could not be sent when their time came. It should stay empty."
  value       = aws_sqs_queue.send_dead_letters.url
}

output "purge_dead_letter_queue" {
  description = "Closed accounts whose mail could not be removed. It should stay empty."
  value       = aws_sqs_queue.purge_dead_letters.url
}

output "receiving_active" {
  description = "Whether SES is routing inbound mail through this stack."
  value       = var.activate_receipt_rule_set
}

output "api_url" {
  description = "Base URL of the JMAP API. Give a mail client this URL, or just an address at the domain when the SRV record exists."
  value       = local.api_custom_domain ? "https://${local.api_hostname}" : aws_apigatewayv2_api.jmap.api_endpoint
}

output "jmap_session_url" {
  value = "${local.api_custom_domain ? "https://${local.api_hostname}" : aws_apigatewayv2_api.jmap.api_endpoint}/.well-known/jmap"
}

output "user_pool_id" {
  value = module.identity.provider.user_pool_id
}

output "user_pool_client_id" {
  value = module.identity.jmap_client_id
}

output "admin_client_id" {
  description = "The client the admin interface signs in to."
  value       = module.identity.admin_client_id
}

output "admin_role" {
  description = "The role whose members may manage accounts."
  value       = module.identity.admin_role
}

output "auth" {
  description = "The identity provider's own pages: where people sign in, sign out and enrol a passkey."
  value       = module.identity.hosted
}

output "webmail_url" {
  description = "Where the webmail is: mail in a browser, for anyone with an account."
  value       = "${local.admin_base_url}/mail/"
}

output "webmail_function" {
  value = aws_lambda_function.webmail.function_name
}

output "admin_function" {
  value = aws_lambda_function.admin.function_name
}

output "admin_url" {
  description = "Where the admin interface is. The first account and administrator are made with `pnpm infra admin create <account>`."
  value       = "${local.admin_base_url}/admin/"
}

output "admin_api_url" {
  description = "Base URL of the admin API. Its OpenAPI document is libs/admin/api/openapi.json."
  value       = "${local.admin_base_url}/admin/api"
}
