import assert from "node:assert/strict";
import test from "node:test";
import {
	parseStartupTimings,
	summarize,
	summarizeTimingMaps,
} from "./profile-coding-agent-node.mjs";

test("parses main and extension timing groups without label collisions", () => {
	const timings = parseStartupTimings(String.raw`
noise before timings
--- Startup Timings: main ---
  process/module startup: 81ms
  createAgentSession: 12ms
  TOTAL: 93ms
-------------------------------
--- Startup Timings: extensions ---
  C:\work\extension.ts module import: 7ms
  package:variant factory: 1.5ms
  TOTAL: 8.5ms
-------------------------------------
noise after timings
`);

	assert.deepEqual(Object.fromEntries(timings), {
		"process/module startup": 81,
		createAgentSession: 12,
		TOTAL: 93,
		[String.raw`extensions: C:\work\extension.ts module import`]: 7,
		"extensions: package:variant factory": 1.5,
		"extensions: TOTAL": 8.5,
	});
});

test("parses the legacy unnamespaced main timing header", () => {
	assert.deepEqual(
		Object.fromEntries(
			parseStartupTimings(`--- Startup Timings ---
  bootstrap: 4ms
  TOTAL: 4ms
------------------------`),
		),
		{ bootstrap: 4, TOTAL: 4 },
	);
});

test("summarizes values and timing maps", () => {
	assert.deepEqual(summarize([7, 1, 5, 3]), {
		min: 1,
		max: 7,
		avg: 4,
		median: 4,
	});

	const summaries = summarizeTimingMaps([
		{ timings: new Map([["main phase", 10], ["extensions: load", 4]]) },
		{ timings: new Map([["main phase", 30]]) },
	]);
	assert.deepEqual(Object.fromEntries(summaries), {
		"main phase": { min: 10, max: 30, avg: 20, median: 20 },
		"extensions: load": { min: 4, max: 4, avg: 4, median: 4 },
	});
});
