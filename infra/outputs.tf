output "dns_records" {
  description = "Records the domain needs. Created automatically when route53_zone_id is set; otherwise add them at your DNS provider."
  value       = local.dns_records
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
  value = aws_cognito_user_pool.main.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.jmap.id
}

output "users" {
  description = "Sign-in names. Set each one's password with `pnpm infra password <name>`."
  value       = sort(keys(aws_cognito_user.account))
}
