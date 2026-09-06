import { describe, expect, test } from "bun:test";
import { isScrubbedEnvVar } from "./ci-test-ts";

describe("CI test child environment", () => {
	test("scrubs profile, managed-model, and provider state inherited from Coreforge", () => {
		for (const name of [
			"BUN_OPTIONS",
			"OMP_NO_ENV_FILE",
			"OMP_DOTENV_OVERRIDE",
			"OMP_PROFILE",
			"OMPPROFILE",
			"PI_PROFILE",
			"PI_CODING_AGENT_DIR",
			"PI_CONFIG_DIR",
			"OMP_AGENT_STRIP",
			"OMPCF_PRODUCT_VERSION",
			"OMPCF_VERSION",
			"OMP_MODEL_ALLOW",
			"OMP_MODEL_AWS_PROFILE",
			"ANTHROPIC_BASE_URL",
			"ANTHROPIC_CUSTOM_HEADERS",
			"ANTHROPIC_AWS_WORKSPACE_ID",
			"ANTHROPIC_API_KEY",
			"AWS_PROFILE",
			"DCG_EXPECTED_AT_STARTUP",
		]) {
			expect(isScrubbedEnvVar(name), name).toBe(true);
		}
	});

	test("retains test-runner controls", () => {
		for (const name of ["OMP_TEST_CONCURRENCY", "OMP_TEST_CHUNK_TIMEOUT", "PI_TEST_RUNTIME"]) {
			expect(isScrubbedEnvVar(name), name).toBe(false);
		}
	});
});
