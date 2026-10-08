import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import {
  LoadError,
  Loading,
  Notice,
  Section,
  StatusBadge,
  Usage,
} from './components';
import { useServices } from './services';

export const ACCOUNT_ID_PATTERN = '[a-z0-9_\\-]{1,64}';

export function AccountsPage() {
  const { api } = useServices();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  return (
    <>
      <h1>Accounts</h1>
      <Section title="All accounts">
        {accounts.isPending ? (
          <Loading what="the accounts" />
        ) : accounts.isError ? (
          <LoadError
            error={accounts.error}
            onRetry={() => void accounts.refetch()}
          />
        ) : accounts.data.length === 0 ? (
          <p className="muted">There are no accounts yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Mailbox</th>
                </tr>
              </thead>
              <tbody>
                {accounts.data.map((account) => (
                  <tr key={account.id}>
                    <th scope="row">
                      <Link to={`/accounts/${account.id}`}>{account.id}</Link>
                    </th>
                    <td>{account.name ?? <span className="muted">—</span>}</td>
                    <td>
                      <StatusBadge status={account.status} />
                    </td>
                    <td>
                      <Usage usage={account.usage} compact />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <CreateAccount />
    </>
  );
}

function CreateAccount() {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.createAccount({ id, name: name.trim() === '' ? null : name.trim() }),
    onSuccess: async (account) => {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void navigate(`/accounts/${account.id}`);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <Section
      title="Create an account"
      description="The new user cannot sign in until you give them a password, and gets no mail until you add an address. Both are on the account’s page."
    >
      <form onSubmit={submit} className="form">
        <div className="field">
          <label htmlFor="new-account-id">Account id</label>
          <input
            id="new-account-id"
            required
            pattern={ACCOUNT_ID_PATTERN}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="new-account-id-hint"
            value={id}
            onChange={(event) => setId(event.target.value)}
          />
          <p id="new-account-id-hint" className="hint">
            Small letters, digits, “-” and “_”. It is what the user signs in
            with, and it can never be changed.
          </p>
        </div>
        <div className="field">
          <label htmlFor="new-account-name">Name (optional)</label>
          <input
            id="new-account-name"
            maxLength={200}
            aria-describedby="new-account-name-hint"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <p id="new-account-name-hint" className="hint">
            Shown as the sender of the account’s mail.
          </p>
        </div>
        <div className="actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={create.isPending}
          >
            Create account
          </button>
        </div>
        <Notice error={create.error} />
      </form>
    </Section>
  );
}
