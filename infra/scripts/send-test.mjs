// Sends a test message through the deployed JMAP API and waits for it to
// arrive: `pnpm infra send-test [recipient]`. By default it writes to an
// address at your own domain, which works while SES is still in its sandbox.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret } from './prompt.mjs';
import { readSettings } from './state-bucket.mjs';

const USING = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:submission',
];
const infraDir = dirname(dirname(fileURLToPath(import.meta.url)));

function terraformOutput(name) {
  try {
    return JSON.parse(
      execFileSync('terraform', ['output', '-json', name], {
        cwd: infraDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch {
    throw new Error(
      `Could not read the "${name}" output. Deploy first with \`pnpm infra apply\`.`,
    );
  }
}

try {
  const { domain } = readSettings(join(infraDir, 'terraform.tfvars'));
  // MAILLESS_API_URL and MAILLESS_USER let this run against something other than the deployment.
  const apiUrl = process.env.MAILLESS_API_URL ?? terraformOutput('api_url');
  const username = process.env.MAILLESS_USER ?? terraformOutput('users')[0];
  if (!username) throw new Error('The deployment has no users.');
  const recipient = process.argv[2] ?? `mailless-test@${domain}`;

  const password = await readSecret(`Password for ${username}: `);
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  const jmap = async (methodCalls) => {
    const response = await fetch(`${apiUrl}/jmap/api`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ using: USING, methodCalls }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401)
      throw new Error('Sign-in was refused. Check the password.');
    const body = await response.json();
    if (!response.ok) {
      throw new Error(
        `The API answered ${response.status}: ${body.detail ?? JSON.stringify(body)}`,
      );
    }
    for (const [name, result] of body.methodResponses) {
      if (name === 'error')
        throw new Error(
          `The API reported ${result.type}: ${result.description ?? ''}`,
        );
    }
    return body.methodResponses.map(([, result]) => result);
  };

  const accountId = username;
  const [identities, mailboxes] = await jmap([
    ['Identity/get', { accountId }, 'i'],
    ['Mailbox/get', { accountId, properties: ['role'] }, 'm'],
  ]);
  const identity = identities.list[0];
  if (!identity)
    throw new Error('This account has no address it may send from.');
  const role = (name) =>
    mailboxes.list.find((mailbox) => mailbox.role === name)?.id;
  const drafts = role('drafts');
  const sent = role('sent');
  const inbox = role('inbox');
  if (!drafts || !sent || !inbox)
    throw new Error('The account is missing its standard mailboxes.');

  // A wildcard identity may send as anything at the domain; pick a concrete address.
  const from = identity.email.startsWith('*@')
    ? `${username}${identity.email.slice(1)}`
    : identity.email;
  // The time keeps each run's subject unique, so its arrival can be recognised.
  const subject = `Mailbox check, ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  console.log(`Sending from ${from} to ${recipient} ...`);

  const [created, submitted] = await jmap([
    [
      'Email/set',
      {
        accountId,
        create: {
          d: {
            mailboxIds: { [drafts]: true },
            keywords: { $draft: true },
            from: [{ name: identity.name || null, email: from }],
            to: [{ email: recipient }],
            subject,
            bodyValues: {
              b: {
                value:
                  'Hello,\n\nThis is a test message from my own mailbox, sent through its JMAP API\n' +
                  'to check that sending and receiving work.\n\nBest regards',
              },
            },
            textBody: [{ partId: 'b', type: 'text/plain' }],
          },
        },
      },
      'c',
    ],
    [
      'EmailSubmission/set',
      {
        accountId,
        create: { s: { identityId: identity.id, emailId: '#d' } },
        onSuccessUpdateEmail: {
          '#s': {
            [`mailboxIds/${drafts}`]: null,
            [`mailboxIds/${sent}`]: true,
            'keywords/$draft': null,
            'keywords/$seen': true,
          },
        },
      },
      's',
    ],
  ]);
  const failure = created.notCreated?.d ?? submitted.notCreated?.s;
  if (failure) {
    throw new Error(
      `The message was not sent (${failure.type}): ${failure.description ?? JSON.stringify(failure)}`,
    );
  }
  console.log('Accepted for delivery, and filed under Sent.');

  const submissionId = submitted.created.s.id;
  const checksArrival = recipient.toLowerCase().endsWith(`@${domain}`);
  let arrived = !checksArrival;
  let report;

  process.stdout.write(
    checksArrival
      ? 'Waiting for it to arrive and for the delivery report '
      : 'Waiting for the delivery report ',
  );
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !(arrived && report)) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    process.stdout.write('.');
    const [found, submissions] = await jmap([
      [
        'Email/query',
        { accountId, filter: { inMailbox: inbox, subject } },
        'q',
      ],
      [
        'EmailSubmission/get',
        { accountId, ids: [submissionId], properties: ['deliveryStatus'] },
        'e',
      ],
    ]);
    if (found.ids.length > 0) arrived = true;
    const status = Object.values(submissions.list[0]?.deliveryStatus ?? {})[0];
    if (status && status.delivered !== 'queued') report = status;
  }
  console.log('');

  if (report?.delivered === 'no') {
    throw new Error(`The message was not delivered: ${report.smtpReply}`);
  }
  if (checksArrival) {
    if (!arrived) {
      throw new Error(
        'It was sent but has not arrived after 90 seconds. Check the ingest logs:\n' +
          '  aws logs tail /aws/lambda/mailless-ingest --since 10m',
      );
    }
    console.log('Arrived in the inbox.');
  }
  if (report) {
    console.log(`Delivery report: delivered (${report.smtpReply}).`);
    console.log('Sending, receiving and delivery reporting all work.');
  } else {
    console.log(
      'No delivery report yet. The message was sent, but its outcome has not been\n' +
        'recorded; check the delivery events function if this persists:\n' +
        '  aws logs tail /aws/lambda/mailless-delivery-events --since 10m',
    );
  }
  process.exit(0);
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}
