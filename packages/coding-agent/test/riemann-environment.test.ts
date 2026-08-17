import { describe, expect, test } from "vitest";
import { formatEnvironmentContext, parseLinuxDistro } from "../src/riemann/environment.ts";

describe("Riemann system environment context", () => {
	test("reads the concrete Linux distribution from os-release", () => {
		expect(parseLinuxDistro('ID=nixos\nNAME=NixOS\nPRETTY_NAME="NixOS 26.05 (Yarara)"\n')).toBe(
			"NixOS 26.05 (Yarara)",
		);
		expect(parseLinuxDistro('ID=debian\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\n')).toBe("Debian GNU/Linux 13");
	});

	test("renders the workspace and concrete host identity without discovery", () => {
		const context = formatEnvironmentContext(
			"/work/project",
			{
				os: "linux",
				distro: "NixOS 26.05 (Yarara)",
				kernel: "6.18.38",
				architecture: "x64",
			},
			new Date(2026, 7, 13),
		);
		expect(context).toBe(
			[
				"- Today: 2026-08-13",
				'- Current working directory: "/work/project"',
				"- OS: linux",
				"- Distro: NixOS 26.05 (Yarara)",
				"- Kernel: 6.18.38",
				"- Architecture: x64",
			].join("\n"),
		);
	});
});
