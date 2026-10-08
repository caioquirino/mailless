# The admin API: accounts, addresses and shares for administrators, and each
# user's own password, passkeys and app passwords. It runs as a function of its
# own so that what may change who has a mailbox is kept apart from what handles
# mail. It can change accounts; it cannot read anyone's mail.

data "archive_file" "admin" {
  type        = "zip"
  source_file = var.admin_bundle
  output_path = "${path.module}/.build/admin.zip"
}

resource "aws_cloudwatch_log_group" "admin" {
  name              = "/aws/lambda/${var.name}-admin"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "admin" {
  name               = "${var.name}-admin"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "admin" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.admin.arn}:*"]
  }

  # The only function that may change who has a mailbox. Listing every account
  # is a scan; changes are transactions made of the item actions below.
  statement {
    sid = "Directory"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [aws_dynamodb_table.directory.arn]
  }

  # App passwords are kept with the mail's metadata, so the table is the same
  # one, but only the partitions that hold app passwords can be reached: their
  # records (R#<account>#AppPassword) and their change log (L#...). An account
  # id has no "#" in it and "#" in a type is written %23, so nothing but the
  # type AppPassword can end a key this way. No Scan: it has no key to check.
  #
  # Every change also moves a counter in the account's state partition
  # (S#<account>), which all of an account's data types share: a condition can
  # name a partition, not an item in it. The counters hold numbers and nothing
  # of anyone's mail. They are in this same statement because a change writes
  # the record, the log and the counter in one transaction, and a transaction
  # whose keys were split over two statements might be allowed by neither.
  statement {
    sid = "AppPasswords"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [aws_dynamodb_table.metadata.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["R#*#AppPassword", "L#*#AppPassword", "S#*"]
    }
  }

  # Users of this stack's pool and no other. Passkeys and a user's own password
  # are changed with that user's token, which needs no permission here.
  statement {
    sid = "ManageUsers"
    actions = [
      "cognito-idp:AdminGetUser",
      "cognito-idp:ListUsers",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminSetUserPassword",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:AdminUserGlobalSignOut",
    ]
    resources = [module.identity.provider.user_pool_arn]
  }

  dynamic "statement" {
    for_each = var.use_customer_kms_key ? [1] : []

    content {
      sid       = "Encryption"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [local.kms_key_arn]
    }
  }
}

resource "aws_iam_role_policy" "admin" {
  name   = "admin"
  role   = aws_iam_role.admin.id
  policy = data.aws_iam_policy_document.admin.json
}

resource "aws_lambda_function" "admin" {
  function_name = "${var.name}-admin"
  role          = aws_iam_role.admin.arn

  filename         = data.archive_file.admin.output_path
  source_code_hash = data.archive_file.admin.output_base64sha256
  handler          = "admin-api.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]

  memory_size = 1024
  # API Gateway gives up after 30 seconds.
  timeout = 29

  environment {
    variables = {
      DIRECTORY_TABLE = aws_dynamodb_table.directory.name
      # Where app passwords are kept.
      TABLE_NAME            = aws_dynamodb_table.metadata.name
      USER_POOL_ID          = module.identity.provider.user_pool_id
      ADMIN_ROLE            = module.identity.admin_role
      PASSKEY_ENROLMENT_URL = module.identity.hosted.passkey_enrolment_url
      # As for the JMAP API, except whom a token must have been issued for:
      # the admin interface, not a mail client.
      OIDC_ISSUER          = module.identity.oidc.issuer
      OIDC_JWKS_URI        = module.identity.oidc.jwks_uri
      OIDC_AUDIENCES       = jsonencode([module.identity.admin_client_id])
      OIDC_AUDIENCE_CLAIM  = module.identity.oidc.audience_claim
      OIDC_USERNAME_CLAIM  = module.identity.oidc.username_claim
      OIDC_ROLES_CLAIM     = module.identity.oidc.roles_claim
      OIDC_REQUIRED_CLAIMS = jsonencode(module.identity.oidc.required_claims)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.admin,
    aws_iam_role_policy.admin,
  ]
}

# ---------------------------------------------------------------------- route

# The gateway checks the token before the function runs, and the function
# checks it again: the first of two checks, not the only one. A token issued
# for a mail client is refused here, since it names another client.
resource "aws_apigatewayv2_authorizer" "admin" {
  api_id           = aws_apigatewayv2_api.jmap.id
  name             = "${var.name}-admin"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer = module.identity.oidc.issuer
    # Cognito's access tokens say whom they are for in client_id, which the
    # gateway accepts in place of aud.
    audience = [module.identity.admin_client_id]
  }
}

resource "aws_apigatewayv2_integration" "admin" {
  api_id                 = aws_apigatewayv2_api.jmap.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.admin.invoke_arn
  payload_format_version = "2.0"
}

# The JMAP routes are each named, and there is no catch-all, so nothing else
# answers under /admin/api.
resource "aws_apigatewayv2_route" "admin" {
  api_id    = aws_apigatewayv2_api.jmap.id
  route_key = "ANY /admin/api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.admin.id}"

  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.admin.id
}

resource "aws_lambda_permission" "api_gateway_invoke_admin" {
  statement_id  = "AllowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.jmap.execution_arn}/*/*/admin/api/*"
}
