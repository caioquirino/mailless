package JMAP::TestSuite::ServerAdapter::Mailless;
use Moose;
with 'JMAP::TestSuite::ServerAdapter';

# Points the suite at the mailless dev server (apps/dev-server). That server
# gives every user name its own account, created on first use, so a fresh
# account is just a user name nobody has used yet.

our $STARTTIME = time();
our $USERNUM   = 1;

has base_uri => (is => 'ro', required => 1);
# The dev server's token, accepted as the password of any user.
has token    => (is => 'ro', required => 1);

sub _account {
  my ($self, $name) = @_;
  return JMAP::TestSuite::Account::Mailless->new({
    server    => $self,
    accountId => $name,
    username  => $name,
  });
}

# Test files run in parallel, so even "any account" is one of its own: tests
# sharing an account would see each other's mail.
sub any_account {
  my ($self) = @_;
  return $self->pristine_account;
}

sub pristine_account {
  my ($self) = @_;
  # The process id keeps parallel test files apart.
  return $self->_account("jt-$STARTTIME-$$-" . $USERNUM++);
}

# Two accounts whose users may each use the other's: signing in as
# "one+other" is the user of "one", with "other" shared with them.
sub pool_account_pair {
  my ($self) = @_;
  my $first  = "jt-$STARTTIME-$$-" . $USERNUM++;
  my $second = "jt-$STARTTIME-$$-" . $USERNUM++;
  return (
    JMAP::TestSuite::Account::Mailless->new({
      server => $self, accountId => $first, username => "$first+$second",
    }),
    JMAP::TestSuite::Account::Mailless->new({
      server => $self, accountId => $second, username => "$second+$first",
    }),
  );
}

package JMAP::TestSuite::Account::Mailless {
  use Moose;
  with 'JMAP::TestSuite::Account';

  use JSON qw(decode_json);
  use LWP::UserAgent;
  use MIME::Base64 qw(encode_base64);
  use JMAP::TestSuite::JMAP::Tester::WithSugar;

  has username => (is => 'ro', required => 1);

  sub authenticated_tester {
    my ($self) = @_;

    my $base  = $self->server->base_uri =~ s{/\z}{}r;
    my $creds = encode_base64($self->username . ':' . $self->server->token, '');

    my $lwp = LWP::UserAgent->new;
    $lwp->default_header(Authorization => "Basic $creds");
    my $res = $lwp->get("$base/.well-known/jmap");
    die "Failed to fetch the session for " . $self->username . ": "
      . $res->status_line . "\n" unless $res->is_success;
    my $session = decode_json($res->decoded_content);

    my ($account_id) = $session->{primaryAccounts}{'urn:ietf:params:jmap:mail'};
    die "The session of " . $self->username . " is for account "
      . ($account_id // '(none)') . ", expected " . $self->accountId . "\n"
      unless defined $account_id && $account_id eq $self->accountId;

    # The URLs are rebuilt from base_uri: the session names the server as it
    # sees itself, which need not be how this container reaches it.
    my $tester = JMAP::TestSuite::JMAP::Tester::WithSugar->new({
      authentication_uri => "$base/.well-known/jmap",
      api_uri      => "$base/jmap/api",
      upload_uri   => "$base/jmap/upload/{accountId}",
      download_uri => "$base/jmap/download/{accountId}/{blobId}/{name}?type={type}",
    });
    $tester->ua->set_default_header(Authorization => "Basic $creds");

    # Tests skip on capabilities missing from this list, so it has to be what
    # the server really offers.
    $tester->default_using([ sort keys %{ $session->{capabilities} // {} } ]);

    return $tester;
  }

  no Moose;
  __PACKAGE__->meta->make_immutable;
}

no Moose;
__PACKAGE__->meta->make_immutable;
