variable "region" {
  description = "AWS region. It must be one where SES can receive email."
  type        = string
}

variable "domain" {
  description = "Domain that receives mail, for example example.com."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.domain))
    error_message = "domain must be a lower-case DNS name such as example.com."
  }
}

variable "mailboxes" {
  description = <<-EOT
    Recipient address to account id. Keys are full addresses ("me@example.com")
    or a whole domain ("*@example.com"); an exact address wins over the
    wildcard. Several addresses may share one account. Mail for any other
    address is accepted by SES and then dropped.
  EOT
  type        = map(string)

  validation {
    condition = alltrue([
      for address, account in var.mailboxes :
      address == lower(address) && can(regex("^[^@\\s]+@[^@\\s]+$", address)) && can(regex("^[A-Za-z0-9_-]{1,64}$", account))
    ])
    error_message = "Keys must be lower-case addresses (or *@domain); account ids may contain letters, digits, '-' and '_' only."
  }
}

variable "activate_receipt_rule_set" {
  description = <<-EOT
    Make this stack's receipt rule set the active one. SES has exactly one
    active rule set per region and account, so setting this to true REPLACES
    any rule set that is active today. No mail is received until it is true.
  EOT
  type        = bool
}

variable "route53_zone_id" {
  description = "Hosted zone of the domain. When set, the MX and DKIM records are created; otherwise they are only shown as outputs for you to add at your DNS provider."
  type        = string
  default     = null
}

variable "api_hostname" {
  description = "Hostname of the JMAP API. Defaults to mail.<domain>. Only used when route53_zone_id is set; otherwise the API is reachable on the address API Gateway generates."
  type        = string
  default     = null
}

variable "api_throttle_rate" {
  description = "Sustained requests per second the API accepts, across all clients."
  type        = number
  default     = 20
}

variable "api_throttle_burst" {
  description = "Short burst of requests the API accepts above the sustained rate."
  type        = number
  default     = 50
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "mailless"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.name))
    error_message = "name must be 2-21 lower-case letters, digits or hyphens, starting with a letter."
  }
}

variable "use_customer_kms_key" {
  description = "Encrypt mail and metadata with a customer-managed KMS key (about 1 USD per month plus requests) instead of the free AWS-managed encryption. Either way everything is encrypted at rest."
  type        = bool
  default     = true
}

variable "inbound_retention_days" {
  description = "Days to keep raw messages that could not be imported before they are deleted."
  type        = number
  default     = 7
}

variable "log_retention_days" {
  description = "Days to keep Lambda logs."
  type        = number
  default     = 30
}

variable "ingest_bundle" {
  description = "Path to the built ingest Lambda bundle. Build it with `pnpm nx build mailless-service`."
  type        = string
  default     = "../apps/mailless-service/dist/ingest.mjs"
}

variable "api_bundle" {
  description = "Path to the built API Lambda bundle. Build it with `pnpm nx build mailless-service`."
  type        = string
  default     = "../apps/mailless-service/dist/api.mjs"
}
