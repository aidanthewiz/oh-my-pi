/**
 * Process-wide greeting name for the signed-in Coreforge identity.
 *
 * `main.ts` resolves the identity once at startup and publishes the first name
 * here; presentation components read it lazily so the welcome screen stays
 * decoupled from identity storage and works unchanged when identity is off.
 */
let greetingName: string | undefined;

export function setCoreforgeGreetingName(name: string | undefined): void {
	greetingName = name?.trim() ? name.trim() : undefined;
}

export function getCoreforgeGreetingName(): string | undefined {
	return greetingName;
}
