import { expect, test } from "bun:test";
import { RelayAuthScreen } from "../src/components/shell/RelayAuthScreen";
import { renderToStaticMarkup } from "react-dom/server";

test("browser approval distinguishes terminal authentication", () => {
	const html = renderToStaticMarkup(<RelayAuthScreen userCode="ABCD-EFGH" />);

	expect(html).toContain("Browser joins require host approval. Terminal joins authenticate automatically.");
	expect(html).toContain("coreforge relay authorize ABCD-EFGH");
	expect(html).toContain("This page connects automatically after approval.");
});

test("browser approval does not show an actionable placeholder command", () => {
	const html = renderToStaticMarkup(<RelayAuthScreen userCode={null} />);

	expect(html).toContain("Requesting code...");
	expect(html).not.toContain("coreforge relay authorize");
	expect(html).not.toContain("ABCD-EFGH");
});
