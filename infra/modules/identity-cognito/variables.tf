variable "name" {
  description = "Prefix for resource names."
  type        = string
}

variable "region" {
  description = "Region of the user pool."
  type        = string
}

variable "account_id" {
  description = "AWS account id. Makes the sign-in hostname unique when it is one Cognito provides."
  type        = string
}

variable "domain" {
  description = "The mail domain. Passkeys are bound to it when the sign-in pages are on a hostname under it."
  type        = string
}

variable "route53_zone_id" {
  description = "Hosted zone of the domain. When set, the sign-in pages get a hostname of our own; otherwise one Cognito provides."
  type        = string
  default     = null
}

variable "auth_hostname" {
  description = "Hostname of the sign-in pages. Only used when route53_zone_id is set."
  type        = string
}

variable "admin_base_url" {
  description = "Where the admin interface is served, without a trailing slash. Sign-in returns to /admin/callback under it."
  type        = string
}

variable "admin_extra_callback_urls" {
  description = "Further addresses sign-in may return to, for running the admin interface locally."
  type        = list(string)
  default     = []
}

variable "admin_role" {
  description = "The role whose members may manage accounts."
  type        = string
  default     = "MAILLESS_ADMIN"
}
