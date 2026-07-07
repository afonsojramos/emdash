---
"@emdash-cms/auth": minor
"emdash": minor
"@emdash-cms/admin": minor
---

Add OAuth-acceptable invites. An invited user can now accept their invite by signing in with a configured OAuth provider (Google/GitHub) instead of only registering a passkey. The invite token is carried through the OAuth `state`, and the callback completes the invite (creating the user with the invited role and linking the OAuth account) only when the provider-verified email matches the invited address, so a login for a different account cannot consume someone else's invite. The invite-accept page now shows the configured providers under an "Or continue with" divider.
