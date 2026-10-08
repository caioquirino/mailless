# The webmail: mail in a browser. A function of its own that hands out the
# pages and does nothing else. It has no access to mail, to accounts or to
# anything but its own log: the pages reach the mail as any mail app does,
# through the JMAP API, with the token of whoever signed in.

data "archive_file" "webmail" {
  type        = "zip"
  source_file = var.webmail_bundle
  output_path = "${path.module}/.build/webmail.zip"
}

resource "aws_cloudwatch_log_group" "webmail" {
  name              = "/aws/lambda/${var.name}-webmail"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "webmail" {
  name               = "${var.name}-webmail"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "webmail" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.webmail.arn}:*"]
  }
}

resource "aws_iam_role_policy" "webmail" {
  name   = "webmail"
  role   = aws_iam_role.webmail.id
  policy = data.aws_iam_policy_document.webmail.json
}

resource "aws_lambda_function" "webmail" {
  function_name = "${var.name}-webmail"
  role          = aws_iam_role.webmail.arn

  filename         = data.archive_file.webmail.output_path
  source_code_hash = data.archive_file.webmail.output_base64sha256
  handler          = "webmail.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]

  memory_size = 512
  timeout     = 10

  environment {
    variables = {
      # What the pages in the browser need to send someone to sign in, handed
      # to them as config.json. None of it is secret: the client has no secret.
      WEBMAIL_CLIENT_ID  = module.identity.webmail_client_id
      AUTH_AUTHORIZE_URL = module.identity.hosted.authorize_url
      AUTH_TOKEN_URL     = module.identity.hosted.token_url
      AUTH_LOGOUT_URL    = module.identity.hosted.logout_url
      AUTH_SCOPES        = jsonencode(module.identity.webmail_scopes)
      # Where someone changes their password and makes app passwords.
      ACCOUNT_URL = "/admin/"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.webmail,
    aws_iam_role_policy.webmail,
  ]
}

resource "aws_apigatewayv2_integration" "webmail" {
  api_id                 = aws_apigatewayv2_api.jmap.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.webmail.invoke_arn
  payload_format_version = "2.0"
}

# The pages and their config.json. They are public, as the files of any web
# application are: there is nothing in them but the program. Reading only, so
# GET and nothing else. The site's own address leads to them.
resource "aws_apigatewayv2_route" "webmail" {
  for_each = toset(["GET /", "GET /mail", "GET /mail/{proxy+}"])

  api_id    = aws_apigatewayv2_api.jmap.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.webmail.id}"

  authorization_type = "NONE"
}

# The gateway may call the function for what is under /mail, for /mail itself
# and for the site's own address, and for nothing else of this API.
resource "aws_lambda_permission" "api_gateway_invoke_webmail" {
  for_each = {
    Pages = "GET/mail/*"
    Mail  = "GET/mail"
    Root  = "GET/"
  }

  statement_id  = "AllowHttpApi${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.webmail.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.jmap.execution_arn}/*/${each.value}"
}
