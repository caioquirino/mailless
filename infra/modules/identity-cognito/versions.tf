terraform {
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
      # The certificate of a sign-in hostname of our own must be in us-east-1,
      # wherever the user pool is.
      configuration_aliases = [aws.us_east_1]
    }
  }
}
