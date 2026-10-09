# The domain's own logo, for mail programs that show one beside a sender's
# mail (BIMI). Published by the domain itself: a record in its DNS says where
# the picture is, and a small function hands the picture out. Nobody else is
# involved and nothing is paid for. Mail services that show a logo without a
# certificate for it (Yahoo and Fastmail, among others) then show this one;
# Gmail and Apple Mail want a certificate bought from an authority, which is
# not something this stack can make.

locals {
  logo_published = var.bimi_logo != null
  logo_url       = "${local.admin_base_url}/bimi/logo.svg"
}

data "archive_file" "logo" {
  count = local.logo_published ? 1 : 0

  type        = "zip"
  output_path = "${path.module}/.build/logo.zip"

  source {
    filename = "logo.svg"
    content  = file(var.bimi_logo)
  }

  # Hands out the one file it was packed with, as a picture and nothing a browser would run.
  source {
    filename = "index.mjs"
    content  = <<-JS
      import { readFileSync } from 'node:fs';

      const logo = readFileSync(new URL('./logo.svg', import.meta.url), 'utf8');

      export const handler = async () => ({
        statusCode: 200,
        headers: {
          'content-type': 'image/svg+xml',
          'cache-control': 'public, max-age=86400',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        },
        body: logo,
      });
    JS
  }
}

resource "aws_cloudwatch_log_group" "logo" {
  count = local.logo_published ? 1 : 0

  name              = "/aws/lambda/${var.name}-logo"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "logo" {
  count = local.logo_published ? 1 : 0

  name               = "${var.name}-logo"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "logo" {
  count = local.logo_published ? 1 : 0

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.logo[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "logo" {
  count = local.logo_published ? 1 : 0

  name   = "logo"
  role   = aws_iam_role.logo[0].id
  policy = data.aws_iam_policy_document.logo[0].json
}

# It can read its own file and write its own log, and nothing else at all.
resource "aws_lambda_function" "logo" {
  count = local.logo_published ? 1 : 0

  function_name = "${var.name}-logo"
  role          = aws_iam_role.logo[0].arn

  filename         = data.archive_file.logo[0].output_path
  source_code_hash = data.archive_file.logo[0].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]

  memory_size = 128
  timeout     = 5

  depends_on = [
    aws_cloudwatch_log_group.logo,
    aws_iam_role_policy.logo,
  ]
}

resource "aws_apigatewayv2_integration" "logo" {
  count = local.logo_published ? 1 : 0

  api_id                 = aws_apigatewayv2_api.jmap.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.logo[0].invoke_arn
  payload_format_version = "2.0"
}

# Public, as a logo is: whoever receives mail from the domain fetches it.
resource "aws_apigatewayv2_route" "logo" {
  count = local.logo_published ? 1 : 0

  api_id    = aws_apigatewayv2_api.jmap.id
  route_key = "GET /bimi/logo.svg"
  target    = "integrations/${aws_apigatewayv2_integration.logo[0].id}"

  authorization_type = "NONE"
}

resource "aws_lambda_permission" "api_gateway_invoke_logo" {
  count = local.logo_published ? 1 : 0

  statement_id  = "AllowHttpApiLogo"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.logo[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.jmap.execution_arn}/*/GET/bimi/logo.svg"
}
