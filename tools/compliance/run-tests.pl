#!/usr/bin/env perl
# Runs test files of the suite and prints one JSON document describing what
# each did: which of its tests passed, failed or were skipped, and why.
#
#   run-tests.pl [--jobs N] [path ...]     paths default to t
use strict;
use warnings;

use File::Find ();
use Getopt::Long qw(GetOptions);
use JSON ();
use TAP::Harness;

GetOptions('jobs=i' => \(my $jobs = 4)) or die "bad options\n";
my @paths = @ARGV ? @ARGV : ('t');

my @files;
for my $path (@paths) {
  if (-d $path) {
    File::Find::find({
      wanted   => sub { push @files, $File::Find::name if /\.t\z/ },
      no_chdir => 1,
    }, $path);
  } elsif (-f $path) {
    push @files, $path;
  } else {
    die "no such test file or directory: $path\n";
  }
}
@files = sort @files;

my %result;
my $harness = TAP::Harness->new({
  lib       => ['lib'],
  jobs      => $jobs,
  verbosity => -3,
});

# A test file reports one top-level result that wraps everything in it. The
# scenarios worth naming are two levels down, where TAP shows them only as
# indented lines, so those are read from the raw output:
#
#   not ok 1 - tests
#       not ok 1 - test from t/Mailbox/get/basic.t
#           not ok 5 - No arguments          <- recorded
my $SCENARIO = qr/\A {8}(not ok|ok) \d+(?: - (.*?))?\s*\z/;

$harness->callback(made_parser => sub {
  my ($parser, $job) = @_;
  my $file = $job->[0];
  my $entry = $result{$file} = { passed => [], failed => [], skipped => [] };
  my %seen;
  $parser->callback(ALL => sub {
    my ($token) = @_;
    my $raw = $token->raw // return;
    # Why a file ran nothing is said in a skip at some other depth.
    $entry->{skipReason} //= $1 if $raw =~ /# skip\s+(\S.*?)\s*\z/i;
    return unless $raw =~ $SCENARIO;
    my ($ok, $name) = ($1, $2 // '');
    my $directive = $name =~ s/\s+# (skip|todo)\b\s*(.*)\z//i ? lc $1 : '';
    my $reason = $2 // '';
    $name = 'unnamed' unless length $name;
    # The same name twice in one file would otherwise be indistinguishable.
    $name .= ' (' . $seen{$name} . ')' if $seen{$name}++;
    if ($directive eq 'skip') {
      push @{ $entry->{skipped} }, { name => $name, reason => $reason };
    } elsif ($ok eq 'ok' || $directive eq 'todo') {
      push @{ $entry->{passed} }, $name;
    } else {
      push @{ $entry->{failed} }, $name;
    }
  });
});

$harness->callback(after_test => sub {
  my ($job, $parser) = @_;
  my $entry = $result{ $job->[0] };
  $entry->{skipAll} = $parser->skip_all if $parser->skip_all;
  # A file that failed without any scenario saying so: it died, or ran a
  # different number of tests than it planned.
  $entry->{broken} = JSON::true
    if !@{ $entry->{failed} }
    && ($parser->has_problems || !$parser->is_good_plan);
});

# Keep the real output for the report; everything the harness prints is discarded.
open my $report, '>&', \*STDOUT or die "cannot keep stdout: $!";
open STDOUT, '>', '/dev/null' or die $!;
$harness->runtests(@files);

print {$report} JSON->new->canonical->pretty->encode({ files => \%result });
