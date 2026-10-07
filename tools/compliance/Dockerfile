# Fastmail's JMAP-TestSuite with its Perl dependencies and the adapter that
# points it at the mailless dev server. Built and run by run.mjs.
FROM perl:5.42

# The suite has no releases; pin the commit so results are comparable over time.
ARG SUITE_REF=b96a3fb123a042adee564f7500a3712a2e31da76

RUN git clone https://github.com/fastmail/JMAP-TestSuite.git /suite \
  && git -C /suite checkout --quiet "$SUITE_REF"

WORKDIR /suite

# Dependencies come with their own test suites, which are not what is being checked here.
RUN cpanm --notest --quiet --installdeps . && rm -rf /root/.cpanm

RUN mkdir account-locks

COPY Mailless.pm lib/JMAP/TestSuite/ServerAdapter/Mailless.pm
COPY run-tests.pl run-tests.pl

ENTRYPOINT ["perl", "-Ilib", "run-tests.pl"]
