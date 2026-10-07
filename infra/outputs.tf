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

output "receiving_active" {
  description = "Whether SES is routing inbound mail through this stack."
  value       = var.activate_receipt_rule_set
}
