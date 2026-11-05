import { X509Certificate } from "node:crypto";
import { AWS_DB_CHINA_ROOTS } from "./aws-db-china-roots";
import { AWS_DB_COMMERCIAL_ROOTS } from "./aws-db-commercial-roots";
import { AWS_DB_GOVCLOUD_ROOTS } from "./aws-db-govcloud-roots";

export const DB_TLS_POLICY_ID = "amazon-rds-partition-roots/v1";
export const DB_TLS_SUPPORTED_PARTITIONS = Object.freeze(["aws", "aws-us-gov", "aws-cn"] as const);

function selectPartitionRoots(
	source: readonly string[],
	subject: RegExp,
): { roots: readonly string[]; regions: readonly string[]; der: readonly string[] } {
	const roots: string[] = [];
	const regions = new Set<string>();
	const der: string[] = [];
	for (const pem of source) {
		const sourcePem = pem.trim();
		if (!/^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END CERTIFICATE-----$/.test(sourcePem)) {
			throw new Error("Invalid AWS DB TLS root certificate");
		}
		const certificate = new X509Certificate(sourcePem);
		const canonicalPem = certificate.toString();
		if (sourcePem !== canonicalPem.trimEnd()) {
			throw new Error("Invalid AWS DB TLS root certificate");
		}
		const region = subject.exec(certificate.subject)?.[1];
		if (
			!region ||
			!certificate.ca ||
			certificate.subject !== certificate.issuer ||
			!certificate.verify(certificate.publicKey)
		) {
			continue;
		}
		roots.push(canonicalPem);
		der.push(certificate.raw.toString("base64"));
		regions.add(region);
	}
	return {
		roots: Object.freeze(roots.sort()),
		regions: Object.freeze([...regions].sort()),
		der: Object.freeze(der.sort()),
	};
}

// Partition-specific production G1 roots only; no proxy, legacy, Beta, or Preview authorities.
const partitionTrust = {
	aws: selectPartitionRoots(
		AWS_DB_COMMERCIAL_ROOTS,
		/(?:^|\n)CN=Amazon RDS ((?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|west)-[1-9]\d*) Root CA (?:RSA2048|RSA4096|ECC384) G1(?:\n|$)/,
	),
	"aws-cn": selectPartitionRoots(
		AWS_DB_CHINA_ROOTS,
		/(?:^|\n)CN=Amazon RDS (cn-(?:north|northwest)-1) Root CA (?:RSA2048|RSA4096|ECC384) G1(?:\n|$)/,
	),
	"aws-us-gov": selectPartitionRoots(
		AWS_DB_GOVCLOUD_ROOTS,
		/(?:^|\n)CN=Amazon RDS (us-gov-(?:east|west)-1) Root CA (?:RSA2048|RSA4096|ECC384) G1(?:\n|$)/,
	),
};
const rootsByPartition = Object.freeze({
	aws: partitionTrust.aws.roots,
	"aws-cn": partitionTrust["aws-cn"].roots,
	"aws-us-gov": partitionTrust["aws-us-gov"].roots,
});

export const DB_TLS_SUPPORTED_REGIONS = Object.freeze({
	aws: partitionTrust.aws.regions,
	"aws-cn": partitionTrust["aws-cn"].regions,
	"aws-us-gov": partitionTrust["aws-us-gov"].regions,
});

// Fixed partition key order and sorted full certificate DER bytes bind the complete trust matrix.
export const DB_TLS_TRUST_FINGERPRINT = `sha256:${new Bun.CryptoHasher("sha256")
	.update(
		JSON.stringify({
			aws: partitionTrust.aws.der,
			"aws-cn": partitionTrust["aws-cn"].der,
			"aws-us-gov": partitionTrust["aws-us-gov"].der,
		}),
	)
	.digest("hex")}`;

export function getAwsDbTlsRoots(partition: "aws" | "aws-us-gov" | "aws-cn"): readonly string[] {
	switch (partition) {
		case "aws":
		case "aws-us-gov":
		case "aws-cn":
			return rootsByPartition[partition];
		default:
			throw new Error("Unsupported AWS DB TLS partition");
	}
}
