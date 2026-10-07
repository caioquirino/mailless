# Compliance testing

`pnpm compliance` runs [Fastmail's JMAP-TestSuite](https://github.com/fastmail/JMAP-TestSuite)
against the dev server and compares the outcome with `baseline.json`. The
suite is written by other people, from the RFCs, which is the point: it finds
the places where this server and its own tests share a misreading.

```sh
pnpm compliance                      # everything, about 20 seconds
pnpm compliance t/Mailbox t/Thread   # some directories or files of the suite
pnpm compliance --verbose t/Mailbox/get/basic.t   # a file's own output, with diagnostics
pnpm compliance --update             # record the outcome as the new baseline
```

It needs Docker. The first run builds an image with the suite and its Perl
dependencies, which takes several minutes; after that the image is reused.

## Reading the result

The table counts test files per area of the suite, and the scenarios inside
them. A file is skipped when the server does not offer what it tests.

`baseline.json` lists everything that is not a plain pass: each failing
scenario by name, and each skipped file with the reason. A run fails when a
scenario fails that is not in the baseline, so the baseline is the list of
known gaps and can only shrink without someone deciding otherwise. When a fix
makes scenarios pass, the run says so; record that with `--update` and commit
the smaller baseline with the fix.

`results.json` (not committed) holds the full outcome of the last complete
run, including the scenarios that passed.

## What is and is not in scope

The suite covers more than this server sets out to do. Skipped by design:
contacts, calendars, principals, quotas and MDN are separate specifications.
Skipped for now: `VacationResponse`, the blob extension, and the tests that
need two accounts sharing data.

A failure is not always a bug here. Each assertion in the suite cites the text
it enforces; read that first. Where the suite expects something the RFC leaves
open, add a `note` to the entry in `baseline.json` saying why it is being left;
`--update` keeps notes for as long as their entry remains.

## How it is put together

| File           | Purpose                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`   | The suite at a pinned commit, with its dependencies. Change `SUITE_REF` to move to a newer suite, then re-record the baseline.            |
| `Mailless.pm`  | The suite's adapter for this server. Every test file gets an account of its own: the dev server creates one for any new plain user name.  |
| `run-tests.pl` | Runs test files inside the container and reports each scenario as JSON.                                                                   |
| `run.mjs`      | Builds the image, starts the dev server on a free port with a random token, runs the suite, prints the table, compares with the baseline. |
