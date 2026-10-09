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

Every test of the suite runs against this server and passes: mail, contacts,
calendars and the core. `baseline.json` is empty, and is there for the day a
newer suite asks for something that is not here yet.

The suite expects one particular behaviour in a few places where the RFCs
allow several. The server follows the suite there, since that is what clients
written against other servers expect; the choices are listed in the
[`jmap-server` README](../../libs/jmap/server/README.md#choices-the-specification-leaves-open).

When a test fails after a change, read the spec citation in its comments
first. If the suite turns out to expect more than the RFC asks, a `note` on
the entry in `baseline.json` records why it is being left; `--update` keeps
notes for as long as their entry remains.

## How it is put together

| File           | Purpose                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`   | The suite at a pinned commit, with its dependencies. Change `SUITE_REF` to move to a newer suite, then re-record the baseline.            |
| `Mailless.pm`  | The suite's adapter for this server. Every test file gets an account of its own: the dev server creates one for any new plain user name.  |
| `run-tests.pl` | Runs test files inside the container and reports each scenario as JSON.                                                                   |
| `run.mjs`      | Builds the image, starts the dev server on a free port with a random token, runs the suite, prints the table, compares with the baseline. |
