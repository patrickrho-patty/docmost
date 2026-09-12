export enum AuthProviderType {
  OIDC = 'oidc',
  SAML = 'saml',
  GOOGLE = 'google',
  LDAP = 'ldap',
}

export const SSO_TXN_COOKIE = 'sso_txn';

export const SSO_TXN_COOKIE_MAX_AGE = 600; // seconds
