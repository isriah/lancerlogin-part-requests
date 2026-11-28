// The part of @lancerlogin/module-sdk/api that the plugin uses at run time. Core provides the real SDK in a composed build.
export function defineApiModule<T>(contribution: T): T { return contribution; }
/** Core's roster projection, word for word, including the columns the plugin must not pass on. */
export function listActiveRosterIdentities(db: any, installationId: string) {
  return db.prepare("SELECT id,external_id AS externalId,first_name AS firstName,last_name AS lastName,email FROM members WHERE installation_id=? AND active=1 ORDER BY last_name,first_name,id LIMIT 500").bind(installationId).all();
}
/** Core's installation time zone projection: a 409 when none is set. */
export async function installationTimeZone(db: any, installationId: string): Promise<string> {
  const row = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id=?").bind(installationId).first();
  if (!row?.timeZone) throw Object.assign(new Error("The installation time zone is not configured"), { status: 409 });
  return row.timeZone;
}
/** Core's report roster read (apps/api/src/module-reporting.ts), with its SQL, including the names and emails the plugin must drop. */
export async function reportRosterData(db: any, today: string) {
  const [membersResult, changesResult] = await Promise.all([
    db.prepare("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, email, discord_user_id AS discordUserId, active FROM members WHERE installation_id = 'primary' ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE, external_id").all(),
    db.prepare("SELECT c.member_id AS memberId, c.label_id AS labelId, l.name AS labelName, c.action, c.effective_date AS effectiveDate FROM member_label_changes c JOIN member_labels l ON l.installation_id=c.installation_id AND l.id=c.label_id WHERE c.installation_id='primary' AND c.effective_date<=? ORDER BY c.effective_date,c.created_at,c.id").bind(today).all(),
  ]);
  const labels = new Map<string, Map<string, string>>();
  for (const change of changesResult.results ?? []) {
    const current = labels.get(change.memberId) ?? new Map<string, string>();
    if (change.action === "add") current.set(change.labelId, change.labelName); else current.delete(change.labelId);
    labels.set(change.memberId, current);
  }
  return { members: membersResult.results ?? [], labels };
}
/**
 * Core's people matching (module SDK 1.10.0): People rows holding exactly one Notion account, from Core's local copy, with no
 * Notion request. The stand-in reads the test tables `core_people_matching` (a row with verified=1 while Core has a verified
 * People database) and `core_people_accounts` (d1.ts), so tests choose each row's `matched`, `memberId` and `name` directly.
 * Undefined while Core has no verified People database, as the real function answers.
 */
export async function listNotionPeopleAccounts(db: any, installationId: string) {
  const [setup, rows] = await Promise.all([
    db.prepare("SELECT verified FROM core_people_matching WHERE installation_id=?").bind(installationId).first(),
    db.prepare("SELECT member_id AS memberId,external_id AS externalId,name,notion_user_id AS notionUserId,matched FROM core_people_accounts WHERE installation_id=? ORDER BY seq").bind(installationId).all(),
  ]);
  if (setup?.verified !== 1) return undefined;
  return (rows.results ?? []).map((row: any) => ({ memberId: row.memberId ?? null, externalId: row.externalId, name: row.name, notionUserId: row.notionUserId, matched: row.matched === 1 }));
}