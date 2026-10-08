# @mailless/identity

Who may sign in. The identity provider (Amazon Cognito, Keycloak, or anything
else that speaks OpenID Connect) stays behind two things: a verifier for the
tokens it issues, and an interface for what is done to its users. Signing in
itself happens on the provider's own pages.

## Verifying tokens

```ts
import { createTokenVerifier } from '@mailless/identity';

const verify = createTokenVerifier({
  issuer: 'https://id.example.com/realms/mail',
  audiences: ['mailless'],
  usernameClaim: 'preferred_username',
  rolesClaim: 'realm_access.roles',
});

const { username, roles, scopes } = await verify(accessToken);
```

The signature is checked against the keys the issuer publishes, then the
issuer, the audience and the expiry. Nothing is particular to one provider:
where they differ is in which claim says what, and that is configuration.

| Option           | Default | For Cognito access tokens |
| ---------------- | ------- | ------------------------- |
| `audienceClaim`  | `aud`   | `client_id`               |
| `usernameClaim`  | `sub`   | `username`                |
| `rolesClaim`     | none    | `cognito:groups`          |
| `requiredClaims` | none    | `{ token_use: 'access' }` |

A token that is not accepted throws `TokenRefusedError`, whose message says
why and never what the token held.
`tokenVerifierOptionsFromEnvironment(process.env)` reads the same options from
`OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCES`, `OIDC_AUDIENCE_CLAIM`,
`OIDC_USERNAME_CLAIM`, `OIDC_ROLES_CLAIM`, `OIDC_REQUIRED_CLAIMS` and
`OIDC_JWKS`.

## Managing users

`IdentityProvider` is what an administrator does to users (create, disable,
delete, set a password, grant and revoke roles, end every session) and what a
signed-in user does to their own credentials with their own access token
(change their password, list and remove their passkeys).

Providers differ, so each says what it can do in `capabilities`, and an
interface built on one hides what it cannot offer. What a provider refuses
throws an `IdentityError` whose `code` is `exists`, `notFound`,
`invalidPassword`, `notAuthorized`, `rateLimited`, `unsupported` or `invalid`.

| Provider                             | Package                                             |
| ------------------------------------ | --------------------------------------------------- |
| In memory, for tests and development | `InMemoryIdentityProvider`, here                    |
| Amazon Cognito                       | [`@mailless/identity-cognito`](../identity-cognito) |

`@mailless/identity/testing` has `describeIdentityContract`, the tests every
provider is meant to pass, and `testKeys` / `issueTestToken` for signing
tokens in tests.
