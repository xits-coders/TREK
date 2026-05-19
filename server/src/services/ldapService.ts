import { Client, InvalidCredentialsError } from 'ldapts';
import fs from 'node:fs';

export interface LdapConfig {
  url:          string;
  bindDn:       string;
  bindPassword: string;
  searchBase:   string;
  searchFilter: string;
  adminGroup:   string;
  allowGroup:   string;
  tlsCa?:       string;
}

export interface LdapUser {
  dn:          string;
  uid:         string;
  email:       string;
  displayName: string;
  isAdmin:     boolean;
}

export function getLdapConfig(): LdapConfig | null {
  if (!process.env.LDAP_URL) return null;
  return {
    url:          process.env.LDAP_URL,
    bindDn:       process.env.LDAP_BIND_DN     || '',
    bindPassword: process.env.LDAP_BIND_PW     || '',
    searchBase:   process.env.LDAP_BASE        || '',
    searchFilter: process.env.LDAP_FILTER      || '(uid={{username}})',
    adminGroup:   process.env.LDAP_ADMIN_GROUP || '',
    allowGroup:   process.env.LDAP_ALLOWED_GROUP,
    tlsCa:        process.env.LDAP_TLS_CA,
  };
}

export async function ldapAuthenticate(
  username: string,
  password: string,
): Promise<LdapUser | null> {
  const config = getLdapConfig();
  if (!config) return null;

  const tlsOptions = config.tlsCa
    ? { ca: [fs.readFileSync(config.tlsCa)] }
    : undefined;

  const client = new Client({ url: config.url, tlsOptions });

  try {
    await client.bind(config.bindDn, config.bindPassword);

    const filter = config.searchFilter.replace('{{username}}', username);
    const { searchEntries } = await client.search(config.searchBase, {
      scope: 'sub',
      filter,
      attributes: ['uid', 'mail', 'cn', 'memberOf'],
    });

    if (!searchEntries.length) return null;

    const entry = searchEntries[0];
    const dn = entry.dn;

    try {
      await client.bind(dn, password);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) return null;
      throw err;
    }

    const raw = entry['memberOf'];
    const groups: string[] = Array.isArray(raw)
      ? raw.map(String)
      : raw ? [String(raw)] : [];

    const isAdmin = config.adminGroup
      ? groups.some(g => g.toLowerCase() === config.adminGroup.toLowerCase())
      : false;

    // Access control: Only members of the allowed group are permitted to enter
    // Exception: Admins are always allowed in
    const allowedGroup = process.config.allowGroup;
    if (allowedGroup && !isAdmin) {
      const allowed = groups.some(g => g.toLowerCase() === allowedGroup.toLowerCase());
      if (!allowed) return null;
    }

    return {
      dn,
      uid:         String(entry['uid']  || username),
      email:       String(entry['mail'] || ''),
      displayName: String(entry['cn']   || username),
      isAdmin,
    };
  } finally {
    await client.unbind();
  }
}
