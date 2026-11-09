// The part of @lancerlogin/module-sdk/api that the plugin uses at run time. Core provides the real SDK in a composed build.
export function defineApiModule<T>(contribution: T): T { return contribution; }
/** Core's roster projection, word for word, including the columns the plugin must not pass on. */
export function listActiveRosterIdentities(db: any, installationId: string) {
  return db.prepare("SELECT id,external_id AS externalId,first_name AS firstName,last_name AS lastName,email FROM members WHERE installation_id=? AND active=1 ORDER BY last_name,first_name,id LIMIT 500").bind(installationId).all();
}
