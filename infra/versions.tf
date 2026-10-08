terraform {
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # The bucket and its region are supplied when initialising. `pnpm infra init`
  # works them out and creates the bucket if it does not exist yet.
  backend "s3" {
    key          = "mailless/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.name
      ManagedBy = "terraform"
    }
  }
}

# The sign-in pages are served through CloudFront, which takes its certificates
# from us-east-1 wherever the rest of the stack is.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = var.name
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  inbound_prefix = "inbound/"
  blob_prefix    = "blobs/"

  rule_set_name = var.name
  rule_name     = "${var.name}-inbound"
  receipt_rule_arn = join(":", [
    "arn", local.partition, "ses", var.region, local.account_id,
    "receipt-rule-set/${local.rule_set_name}:receipt-rule/${local.rule_name}",
  ])
}
