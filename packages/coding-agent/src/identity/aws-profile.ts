/**
 * Adopt-or-seed resolution for the managed AWS profile (IAM Identity Center).
 *
 * The managed org config carries the Identity Center constants (start URL,
 * SSO region, account id, role name). Given those, a machine needs a
 * `~/.aws/config` profile pointing at them before `aws sso login` /
 * `sts get-caller-identity --profile …` can work. Resolution order:
 *
 *  1. ADOPT — scan `~/.aws/config` for an existing profile whose account,
 *     portal, AND role match the managed constants. Content-keyed, any profile
 *     name: an employee's existing managed-role profile is used as-is.
 *  2. SEED — no match: append the managed profile (modern `sso-session`
 *     shape) under the managed name. A name collision with non-matching
 *     content is NEVER overwritten (it is user config); the managed block is
 *     seeded under a `coreforge-` prefixed fallback name instead, so a stale
 *     or foreign profile of the same name cannot hijack org routing.
 *
 * Post-login, callers must additionally assert the STS `Account` equals the
 * managed account id (see `ensureCoreforgeAwsSso` callers) so a mis-adopted
 * static profile can never silently route to a foreign account.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AWS_PROFILE_PATTERN, AWS_REGION_PATTERN, CONTROL_CHARACTER_PATTERN } from "./aws-patterns";

const SSO_ROLE_NAME_PATTERN = /^[A-Za-z0-9+=,.@_-]{1,64}$/;

export interface CoreforgeAwsSsoConstants {
	profile: string;
	region: string;
	ssoStartUrl: string;
	ssoRegion: string;
	ssoAccountId: string;
	ssoRoleName: string;
}

export interface ResolvedAwsProfile {
	/** Profile name to use with `--profile`. */
	profile: string;
	/** How the profile was obtained. */
	source: "adopted" | "seeded" | "existing-managed";
}

interface IniSections {
	[section: string]: Record<string, string>;
}

function parseIni(text: string): IniSections {
	const out: IniSections = {};
	let current: Record<string, string> | undefined;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[") && line.endsWith("]")) {
			const name = line.slice(1, -1).trim();
			current = out[name] ?? {};
			out[name] = current;
			continue;
		}
		if (!current) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		current[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
	}
	return out;
}

function normalizeStartUrl(url: string): string {
	// Console copies sometimes carry a fragment (`…/start/#/?tab=accounts`);
	// the SSO OIDC service treats these as the same portal. Compare without
	// the fragment and without trailing slashes.
	const hashIndex = url.indexOf("#");
	const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
	return base.trim().replace(/\/+$/, "");
}

function sectionStartUrl(section: Record<string, string>, ini: IniSections): string | undefined {
	if (section.sso_start_url) return section.sso_start_url;
	const sessionName = section.sso_session;
	if (!sessionName) return undefined;
	return ini[`sso-session ${sessionName}`]?.sso_start_url;
}

/**
 * Resolve a usable profile for the managed Identity Center constants —
 * adopting a matching existing profile, else seeding the managed block.
 * Throws only on invalid managed constants or an unwritable config file.
 */
export function resolveOrSeedCoreforgeAwsProfile(
	constants: CoreforgeAwsSsoConstants,
	configPath: string = path.join(os.homedir(), ".aws", "config"),
): ResolvedAwsProfile {
	if (!AWS_PROFILE_PATTERN.test(constants.profile)) {
		throw new Error(`Invalid managed AWS profile name: ${constants.profile || "<empty>"}`);
	}
	if (!/^\d{12}$/.test(constants.ssoAccountId)) {
		throw new Error(`Invalid managed AWS account id: ${constants.ssoAccountId || "<empty>"}`);
	}
	if (!AWS_REGION_PATTERN.test(constants.region)) {
		throw new Error(`Invalid managed AWS region: ${constants.region || "<empty>"}`);
	}
	if (!AWS_REGION_PATTERN.test(constants.ssoRegion)) {
		throw new Error(`Invalid managed AWS SSO region: ${constants.ssoRegion || "<empty>"}`);
	}
	if (!SSO_ROLE_NAME_PATTERN.test(constants.ssoRoleName)) {
		throw new Error(`Invalid managed AWS SSO role name: ${constants.ssoRoleName || "<empty>"}`);
	}
	if (CONTROL_CHARACTER_PATTERN.test(constants.ssoStartUrl)) {
		throw new Error("Invalid managed AWS SSO start URL: control characters are not allowed");
	}
	let startUrl: URL;
	try {
		startUrl = new URL(constants.ssoStartUrl);
	} catch {
		throw new Error(`Invalid managed AWS SSO start URL: ${constants.ssoStartUrl || "<empty>"}`);
	}
	if (startUrl.protocol !== "https:" || !startUrl.hostname || startUrl.username || startUrl.password) {
		throw new Error(`Invalid managed AWS SSO start URL: ${constants.ssoStartUrl || "<empty>"}`);
	}
	let ini: IniSections = {};
	let raw = "";
	try {
		raw = fs.readFileSync(configPath, "utf8");
		ini = parseIni(raw);
	} catch {
		// Missing file — seed from scratch below.
	}

	const wantUrl = normalizeStartUrl(constants.ssoStartUrl);
	// 1. Adopt: content-keyed scan over every profile section.
	for (const [name, section] of Object.entries(ini)) {
		if (!name.startsWith("profile ") && name !== "default") continue;
		if (section.sso_account_id !== constants.ssoAccountId) continue;
		if (section.sso_role_name !== constants.ssoRoleName) continue;
		const url = sectionStartUrl(section, ini);
		if (!url || normalizeStartUrl(url) !== wantUrl) continue;
		const profileName = name === "default" ? "default" : name.slice("profile ".length).trim();
		const managedName = profileName === constants.profile;
		return { profile: profileName, source: managedName ? "existing-managed" : "adopted" };
	}

	// 2. Seed. Collision-safe: a same-named profile with non-matching content
	// is user config — never overwrite; fall back to a coreforge- name.
	let seedName = constants.profile;
	if (ini[`profile ${seedName}`]) {
		seedName = `coreforge-${constants.profile}`;
		if (ini[`profile ${seedName}`]) {
			throw new Error(
				`AWS profiles '${constants.profile}' and '${seedName}' both exist but neither matches the managed ` +
					`Identity Center account, portal, and role. Remove or fix one, or set identity.aws.profile.`,
			);
		}
	}
	// Session block: reuse only when content matches the managed constants.
	// A stale block (rotated portal URL/region) must not be referenced — the
	// file is append-only, so seed a fresh collision-safe session name instead.
	let sessionName = `coreforge-${constants.profile}`;
	let needSession = true;
	for (let n = 2; ; n++) {
		const existing = ini[`sso-session ${sessionName}`];
		if (!existing) break;
		if (
			normalizeStartUrl(existing.sso_start_url ?? "") === wantUrl &&
			(existing.sso_region ?? "").trim() === constants.ssoRegion
		) {
			needSession = false;
			break;
		}
		sessionName = `coreforge-${constants.profile}-${n}`;
	}
	const lines: string[] = [];
	if (raw.length > 0 && !raw.endsWith("\n")) lines.push("");
	lines.push(
		"",
		"# Seeded by coreforge (managed Identity Center profile). Safe to edit;",
		"# coreforge adopts any profile matching the managed account + portal + role.",
	);
	if (needSession) {
		lines.push(
			`[sso-session ${sessionName}]`,
			`sso_start_url = ${constants.ssoStartUrl}`,
			`sso_region = ${constants.ssoRegion}`,
			"sso_registration_scopes = sso:account:access",
		);
	}
	lines.push(
		`[profile ${seedName}]`,
		`sso_session = ${sessionName}`,
		`sso_account_id = ${constants.ssoAccountId}`,
		`sso_role_name = ${constants.ssoRoleName}`,
		`region = ${constants.region}`,
		"",
	);
	fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
	fs.appendFileSync(configPath, lines.join("\n"), { mode: 0o600 });
	// appendFileSync's mode only applies on creation; harden a pre-existing
	// config too (it now names the org account and SSO portal). Best-effort:
	// a foreign-owned file must not fail the seed.
	try {
		fs.chmodSync(configPath, 0o600);
	} catch {
		// keep the seeded profile usable even when chmod is not permitted
	}
	return { profile: seedName, source: "seeded" };
}
