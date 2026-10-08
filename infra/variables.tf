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

variable "account_quota_bytes" {
  description = <<-EOT
    How much mail an account may hold, in bytes, when it has no limit of its
    own (those are set in the admin interface), or null for no limit. With a
    limit, mail apps can show how full the mailbox is, and the user cannot add
    mail beyond it. Mail arriving from outside is always delivered.
  EOT
  type        = number
  default     = null

  validation {
    condition     = var.account_quota_bytes == null || try(var.account_quota_bytes >= 1048576 && floor(var.account_quota_bytes) == var.account_quota_bytes, false)
    error_message = "The quota must be a whole number of bytes, at least 1 MB, or null."
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

variable "mail_from_subdomain" {
  description = "Subdomain used as the envelope sender of outgoing mail, where bounces are returned."
  type        = string
  default     = "bounce"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.mail_from_subdomain))
    error_message = "mail_from_subdomain must be a single lower-case DNS label."
  }
}

variable "dmarc_policy" {
  description = <<-EOT
    DMARC policy published for the domain: "none", "quarantine" or "reject".
    Set to null to publish no DMARC record, for example when the domain
    already has one or also sends mail through another service that does not
    sign with DKIM.
  EOT
  type        = string
  default     = "quarantine"

  validation {
    condition     = var.dmarc_policy == null ? true : contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be none, quarantine, reject or null."
  }
}

variable "alarm_email" {
  description = "Address that is told when bounce or complaint rates climb, or when mail could not be processed. AWS sends a confirmation link to it first. Leave null to have the alarms visible in CloudWatch only."
  type        = string
  default     = null

  validation {
    condition     = var.alarm_email == null ? true : can(regex("^[^@\\s]+@[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email must be an email address or null."
  }
}

variable "api_hostname" {
  description = "Hostname of the JMAP API. Defaults to mail.<domain>. Only used when route53_zone_id is set; otherwise the API is reachable on the address API Gateway generates."
  type        = string
  default     = null
}

variable "auth_hostname" {
  description = <<-EOT
    Hostname of the sign-in pages. Defaults to auth.<domain>. Only used when
    route53_zone_id is set; otherwise the pages are on a hostname Cognito
    provides. Its parent domain must have an A record, or Cognito refuses it.
    Passkeys are bound to the mail domain as long as this hostname is under it.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.auth_hostname == null ? true : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.auth_hostname))
    error_message = "auth_hostname must be a lower-case DNS name such as auth.example.com."
  }
}

variable "admin_extra_callback_urls" {
  description = <<-EOT
    Further addresses the admin interface may be signed in to from, besides
    the deployed one. For running it on your own machine, for example
    ["http://localhost:5173/admin/callback"].
  EOT
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for url in var.admin_extra_callback_urls :
      can(regex("^https://[^\\s]+$", url)) || can(regex("^http://localhost(:[0-9]+)?(/[^\\s]*)?$", url))
    ])
    error_message = "Each address must be https, or http://localhost for local development."
  }
}

variable "webmail_extra_callback_urls" {
  description = <<-EOT
    Further addresses the webmail may be signed in to from, besides the
    deployed one. For running it on your own machine, for example
    ["http://localhost:5174/mail/callback"].
  EOT
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for url in var.webmail_extra_callback_urls :
      can(regex("^https://[^\\s]+$", url)) || can(regex("^http://localhost(:[0-9]+)?(/[^\\s]*)?$", url))
    ])
    error_message = "Each address must be https, or http://localhost for local development."
  }
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

variable "push_bundle" {
  description = "Path to the built push Lambda bundle. Build it with `pnpm nx build mailless-service`."
  type        = string
  default     = "../apps/mailless-service/dist/push.mjs"
}

variable "send_bundle" {
  description = "Path to the built scheduled-send Lambda bundle. Build it with `pnpm nx build mailless-service`."
  type        = string
  default     = "../apps/mailless-service/dist/send.mjs"
}

variable "admin_bundle" {
  description = "Path to the built admin API Lambda bundle. Build it with `pnpm nx build mailless-service`."
  type        = string
  default     = "../apps/mailless-service/dist/admin-api.mjs"
}

variable "webmail_bundle" {
  description = "Path to the built webmail Lambda bundle. Build it with `pnpm nx build mailless-service`."
  type        = string
  default     = "../apps/mailless-service/dist/webmail.mjs"
}

variable "purge_bundle" {
  description = "Path to the built purge Lambda bundle. Build it with `pnpm nx build mailless-service`."
  type        = string
  default     = "../apps/mailless-service/dist/purge.mjs"
}

variable "events_bundle" {
  description = "Path to the built delivery events Lambda bundle. Build it with `pnpm nx build mailless-service`."
  type        = string
  default     = "../apps/mailless-service/dist/events.mjs"
}
