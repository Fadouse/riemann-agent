import { readFileSync } from "node:fs";
import { arch, platform, release } from "node:os";

export interface HostEnvironment {
	os: string;
	distro?: string;
	kernel: string;
	architecture: string;
	shell?: string;
}

function unquoteOsReleaseValue(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const quote = trimmed[0];
		if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) {
			return trimmed.slice(1, -1).replace(/\\([\\"'$`])/g, "$1");
		}
	}
	return trimmed;
}

export function parseLinuxDistro(content: string): string | undefined {
	const values = new Map<string, string>();
	for (const line of content.split(/\r?\n/)) {
		const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
		if (match) values.set(match[1], unquoteOsReleaseValue(match[2]));
	}
	const prettyName = values.get("PRETTY_NAME")?.trim();
	if (prettyName) return prettyName;
	const name = values.get("NAME")?.trim();
	if (!name) return undefined;
	const version = values.get("VERSION_ID")?.trim();
	return version ? `${name} ${version}` : name;
}

export function detectHostEnvironment(): HostEnvironment {
	let distro: string | undefined;
	if (platform() === "linux") {
		try {
			distro = parseLinuxDistro(readFileSync("/etc/os-release", "utf8"));
		} catch {
			// The kernel identity below remains sufficient on systems without os-release.
		}
	}
	return {
		os: platform(),
		distro,
		kernel: release(),
		architecture: arch(),
		shell: process.env.SHELL,
	};
}

function localDate(now: Date): string {
	const year = String(now.getFullYear());
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function formatEnvironmentContext(
	cwd: string,
	host: HostEnvironment = detectHostEnvironment(),
	now: Date = new Date(),
): string {
	const lines = [
		`- Today: ${localDate(now)}`,
		`- Current working directory: ${JSON.stringify(cwd)}`,
		`- OS: ${host.os}`,
	];
	if (host.distro) lines.push(`- Distro: ${host.distro}`);
	lines.push(`- Kernel: ${host.kernel}`, `- Architecture: ${host.architecture}`);
	if (host.shell) lines.push(`- Shell: ${JSON.stringify(host.shell)}`);
	return lines.join("\n");
}
