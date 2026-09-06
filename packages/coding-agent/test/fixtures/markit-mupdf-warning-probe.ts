import { convertBufferWithMarkit } from "@oh-my-pi/pi-coding-agent/utils/markit";
import { logger } from "@oh-my-pi/pi-utils";

function warningPdf(): Uint8Array {
	const objects: string[] = [];
	const add = (body: string): void => {
		objects.push(body);
	};
	const pageText = "/P <</MCID 0>> BDC\nBT /F1 24 Tf 72 720 Td (Tagged PDF repro text) Tj ET\nEMC\n";
	add("<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 8 0 R >>");
	add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
	add(
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /StructParents 0 /Annots [9 0 R] >>",
	);
	add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	add(`<< /Length ${pageText.length} >>\nstream\n${pageText}endstream`);
	add("<< /Nums [0 [7 0 R]] >>");
	add("<< /Type /StructElem /S /P /P 8 0 R /Pg 3 0 R /K 99 >>");
	add("<< /Type /StructTreeRoot /K [7 0 R] /ParentTree 6 0 R /ParentTreeNextKey 1 >>");
	add("<< /Type /Annot /Subtype /Screen /Rect [72 650 200 700] /T (movie) >>");

	let pdf = "%PDF-1.7\n";
	const offsets = [0];
	for (let i = 0; i < objects.length; i++) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
	}

	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (let i = 1; i < offsets.length; i++) {
		pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}

logger.setTransports({ console: false, file: false });
const events: logger.LogEvent[] = [];
const dispose = logger.registerLogSink(event => events.push(event));
const consoleErrors: string[] = [];
const originalConsoleError = console.error;
console.error = (...values: unknown[]) => {
	consoleErrors.push(values.map(String).join(" "));
};

try {
	const result = await convertBufferWithMarkit(warningPdf(), ".pdf", undefined, { useCache: false });
	process.stdout.write(JSON.stringify({ result, events, consoleErrors }));
} finally {
	console.error = originalConsoleError;
	dispose();
}
