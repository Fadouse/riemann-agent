import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			coverage: {
				provider: "v8",
				all: true,
				include: ["src/**/*.ts"],
				exclude: ["src/**/*.d.ts"],
				reporter: ["text", "html", "lcov"],
				reportsDirectory: "coverage",
			},
		},
		resolve: { conditions: ["source"] },
		ssr: { resolve: { conditions: ["source"] } },
	}),
);
