import { describe, expect, it } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import {
	DB_TLS_SUPPORTED_PARTITIONS,
	DB_TLS_SUPPORTED_REGIONS,
	DB_TLS_TRUST_FINGERPRINT,
	getAwsDbTlsRoots,
} from "@oh-my-pi/pi-coding-agent/tools/aws-db-tls";

type Partition = (typeof DB_TLS_SUPPORTED_PARTITIONS)[number];

function commonName(certificate: X509Certificate): string {
	return /(?:^|\n)CN=([^\n]+)/.exec(certificate.subject)?.[1] ?? "";
}

function expectSelfSignedRoots(certificates: X509Certificate[]): void {
	for (const certificate of certificates) {
		expect(certificate.ca).toBe(true);
		expect(certificate.issuer).toBe(certificate.subject);
		expect(certificate.verify(certificate.publicKey)).toBe(true);
	}
}

function expectApprovedRoots(partition: Partition, fingerprints: Record<string, string>): void {
	const certificates = getAwsDbTlsRoots(partition).map(pem => new X509Certificate(pem));
	expect(certificates.map(certificate => `${commonName(certificate)}:${certificate.fingerprint256}`).sort()).toEqual(
		Object.entries(fingerprints)
			.map(([name, fingerprint]) => `${name}:${fingerprint}`)
			.sort(),
	);
	expectSelfSignedRoots(certificates);
}

describe("aws_db partition-specific TLS trust", () => {
	it("trusts the six approved GovCloud G1 roots, not rotation-sensitive intermediates", () => {
		expectApprovedRoots("aws-us-gov", {
			"Amazon RDS us-gov-west-1 Root CA RSA2048 G1":
				"4F:9A:3F:47:68:97:12:3F:FD:6F:4B:E6:95:0B:31:F6:08:69:84:8E:DD:C6:41:03:D7:29:AF:A9:17:46:B0:A8",
			"Amazon RDS us-gov-west-1 Root CA RSA4096 G1":
				"FB:B5:26:46:A8:7A:80:DA:5A:7E:07:81:21:9A:EF:06:54:9B:70:31:F5:8F:0F:AE:A4:75:83:9F:C1:13:FC:ED",
			"Amazon RDS us-gov-west-1 Root CA ECC384 G1":
				"DF:86:2C:D4:19:97:53:45:E6:A5:20:09:20:6B:24:27:9E:E5:62:80:89:AA:74:BE:9A:8B:F0:B5:53:C5:E7:13",
			"Amazon RDS us-gov-east-1 Root CA RSA2048 G1":
				"08:25:E2:E3:5C:A6:5D:F5:7C:62:70:A5:FE:C6:1C:5C:AE:75:7A:C1:10:66:4C:8C:82:4A:26:36:0B:7A:32:DC",
			"Amazon RDS us-gov-east-1 Root CA RSA4096 G1":
				"2E:D6:4E:E6:C2:E6:C1:A9:B8:86:B7:75:EE:FB:1D:CE:D7:EA:2F:C4:FE:95:C8:6A:F7:7D:06:50:76:3D:F3:01",
			"Amazon RDS us-gov-east-1 Root CA ECC384 G1":
				"27:E7:16:6E:25:30:42:53:22:A2:F2:B6:5E:3E:D7:AD:65:AB:C2:10:7D:19:62:50:65:75:20:CD:57:BF:CB:63",
		});
	});

	it("trusts the six approved China G1 roots without commercial or GovCloud fallback", () => {
		expectApprovedRoots("aws-cn", {
			"Amazon RDS cn-north-1 Root CA RSA2048 G1":
				"05:16:86:05:F9:48:5B:F9:B2:DD:30:65:93:C8:A2:1D:C8:91:A6:D6:7A:36:2E:68:10:58:00:0C:68:1A:A8:11",
			"Amazon RDS cn-north-1 Root CA RSA4096 G1":
				"52:CD:C6:B4:76:2E:89:CE:23:A7:A9:2D:61:8B:74:30:A1:B6:3E:C2:34:20:49:01:8B:08:A9:6D:66:F5:D1:1B",
			"Amazon RDS cn-north-1 Root CA ECC384 G1":
				"D5:8B:FF:41:A1:AE:79:F3:7F:0D:00:3E:92:75:60:B0:96:54:04:2B:EE:08:3D:E8:38:6A:74:CA:BF:6D:0E:50",
			"Amazon RDS cn-northwest-1 Root CA RSA2048 G1":
				"5D:2B:52:68:7A:35:99:F6:18:06:5C:94:8E:9F:BF:FD:04:FB:91:76:79:11:BB:EB:6B:68:A0:CF:E7:83:63:9B",
			"Amazon RDS cn-northwest-1 Root CA RSA4096 G1":
				"5B:67:FC:93:FC:4D:8C:51:F6:BE:E8:2A:E3:4C:AC:06:A6:D7:6E:8A:D3:2C:9A:15:2D:7E:9F:6C:8E:92:5F:30",
			"Amazon RDS cn-northwest-1 Root CA ECC384 G1":
				"0D:15:41:13:CF:93:1D:AD:D4:1B:64:2F:56:48:50:13:F7:EC:52:1B:57:70:76:3F:74:CE:30:98:11:69:9D:20",
		});
	});

	it("trusts all current production commercial G1 roots without legacy, proxy, Beta or Preview CAs", () => {
		const certificates = getAwsDbTlsRoots("aws").map(pem => new X509Certificate(pem));
		const regions = [
			"af-south-1",
			"ap-east-1",
			"ap-east-2",
			"ap-northeast-1",
			"ap-northeast-2",
			"ap-northeast-3",
			"ap-south-1",
			"ap-south-2",
			"ap-southeast-1",
			"ap-southeast-2",
			"ap-southeast-3",
			"ap-southeast-4",
			"ap-southeast-5",
			"ap-southeast-6",
			"ap-southeast-7",
			"ca-central-1",
			"ca-west-1",
			"eu-central-1",
			"eu-central-2",
			"eu-north-1",
			"eu-south-1",
			"eu-south-2",
			"eu-west-1",
			"eu-west-2",
			"eu-west-3",
			"il-central-1",
			"me-central-1",
			"me-south-1",
			"me-west-1",
			"mx-central-1",
			"sa-east-1",
			"sa-west-1",
			"us-east-1",
			"us-east-2",
			"us-west-1",
			"us-west-2",
		];
		expect(certificates.map(commonName).sort()).toEqual(
			regions
				.flatMap(region =>
					["RSA2048", "RSA4096", "ECC384"].map(family => `Amazon RDS ${region} Root CA ${family} G1`),
				)
				.sort(),
		);
		expectSelfSignedRoots(certificates);
	});

	it("advertises only regions with selected trust anchors so unsupported regions can fail before authentication", () => {
		for (const partition of DB_TLS_SUPPORTED_PARTITIONS) {
			const regions = new Set(
				getAwsDbTlsRoots(partition).map(pem => {
					const name = commonName(new X509Certificate(pem));
					const region = /^Amazon RDS ([a-z0-9-]+) Root CA (?:RSA2048|RSA4096|ECC384) G1$/.exec(name)?.[1];
					if (region === undefined) throw new Error("Trusted certificate has no recognized region");
					return region;
				}),
			);
			expect(DB_TLS_SUPPORTED_REGIONS[partition]).toEqual([...regions].sort());
		}
	});

	it("rejects unknown and absent partitions rather than selecting another trust store", () => {
		expect(() => getAwsDbTlsRoots("constructor" as Partition)).toThrow();
		expect(() => getAwsDbTlsRoots(undefined as unknown as Partition)).toThrow();
	});

	it("prevents callers from changing approved root bytes or advertised partition and region coverage", () => {
		expect(Reflect.set(DB_TLS_SUPPORTED_PARTITIONS, 0, "aws-iso")).toBe(false);
		expect(Reflect.set(DB_TLS_SUPPORTED_REGIONS, "aws", ["us-iso-east-1"])).toBe(false);
		for (const partition of DB_TLS_SUPPORTED_PARTITIONS) {
			const roots = getAwsDbTlsRoots(partition);
			const original = [...roots];
			expect(Reflect.set(roots, 0, "untrusted-root")).toBe(false);
			expect(Reflect.set(roots, "length", 0)).toBe(false);
			expect(Reflect.set(DB_TLS_SUPPORTED_REGIONS[partition], 0, "us-iso-east-1")).toBe(false);
			expect(getAwsDbTlsRoots(partition)).toEqual(original);
		}
	});

	it("exposes one canonical PEM certificate per entry so TLS cannot trust bytes outside the DER identity", () => {
		for (const partition of DB_TLS_SUPPORTED_PARTITIONS) {
			for (const pem of getAwsDbTlsRoots(partition)) {
				expect(pem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(1);
				expect(pem).toBe(new X509Certificate(pem).toString());
			}
		}
	});

	it("binds capability trust identity to every complete certificate DER byte in canonical partition and root order", () => {
		const material = JSON.stringify({
			aws: getAwsDbTlsRoots("aws")
				.map(pem => new X509Certificate(pem).raw.toString("base64"))
				.sort(),
			"aws-cn": getAwsDbTlsRoots("aws-cn")
				.map(pem => new X509Certificate(pem).raw.toString("base64"))
				.sort(),
			"aws-us-gov": getAwsDbTlsRoots("aws-us-gov")
				.map(pem => new X509Certificate(pem).raw.toString("base64"))
				.sort(),
		});
		expect(DB_TLS_TRUST_FINGERPRINT).toBe(`sha256:${createHash("sha256").update(material, "utf8").digest("hex")}`);
		expect(DB_TLS_TRUST_FINGERPRINT).toBe("sha256:b46e17b6576526ba99028c668f7d8a393b9554d324b5f99c8f0cb843e0161ff6");
	});
});
