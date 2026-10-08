# @mailless/identity-cognito

Amazon Cognito as the identity provider behind
[`@mailless/identity`](../core).

```ts
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoIdentityProvider } from '@mailless/identity-cognito';

const identity = new CognitoIdentityProvider({
  client: new CognitoIdentityProviderClient({}),
  userPoolId: 'eu-west-1_Example',
});
```

- Users are created without Cognito writing to them and without a way to sign
  in: an administrator sets a password, and the user adds a passkey on
  Cognito's own page.
- Roles are user pool groups. The group must exist before it can be granted.
- A user's own password and passkeys are changed with that user's access
  token, which needs the scope `aws.cognito.signin.user.admin`.
- Cognito has no call by which an administrator removes another user's
  passkey, so `capabilities.removePasskeysOfOthers` is false. An administrator
  can reset the password, end every session, or disable the user.

Cognito's error messages can name the user they are about. The errors thrown
here do not.

The administrative calls need these IAM actions on the user pool:
`cognito-idp:AdminGetUser`, `ListUsers`, `AdminListGroupsForUser`,
`AdminCreateUser`, `AdminEnableUser`, `AdminDisableUser`, `AdminDeleteUser`,
`AdminSetUserPassword`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup` and
`AdminUserGlobalSignOut`. The calls made with a user's token need none.
