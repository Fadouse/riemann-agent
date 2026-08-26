import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { IPythonToolDetails } from "../src/riemann/ipython.ts";
import { RiemannRuntime } from "../src/riemann/runtime.ts";

const roots: string[] = [];
const bwrap = process.env.RIEMANN_BWRAP_PATH ?? "/run/current-system/sw/bin/bwrap";

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function executePolicy(policy: "allow" | "deny", port: number): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `riemann-network-${policy}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "config.yaml"),
		`version: 1
agents:
  main:
    network: ${policy}
`,
	);
	const previousAgentDir = process.env.RIEMANN_CODING_AGENT_DIR;
	process.env.RIEMANN_CODING_AGENT_DIR = agentDir;
	let runtime: RiemannRuntime | undefined;
	try {
		const context = {
			cwd: root,
			model: undefined,
			modelRegistry: { find: () => undefined },
			thinkingLevel: "off",
			sessionManager: { getSessionId: () => `network-${policy}-${port}` },
			isProjectTrusted: () => true,
		} as unknown as ExtensionContext;
		runtime = await RiemannRuntime.createRoot(context);
		const result = await runtime.toolDefinition().execute(
			`network-${policy}`,
			{
				code: `import socket
ipython_connected = False
try:
    connection = socket.create_connection(("127.0.0.1", ${port}), timeout=2)
    connection.close()
    ipython_connected = True
except OSError:
    pass
shell_result = await shell.run(script="printf ping > /dev/tcp/127.0.0.1/${port}", timeout=5)
status = await state.status()
(ipython_connected, shell_result.exit_code == 0, status["network"], hasattr(web, "fetch"), hasattr(mcp, "open"))`,
			},
			undefined,
			undefined,
			context,
		);
		const details = result.details as IPythonToolDetails | undefined;
		if (details?.status !== "ok") {
			const failure = result.content.find((item) => item.type === "text");
			throw new Error(failure?.type === "text" ? failure.text : `Network ${policy} cell failed`);
		}
		const output = result.content.find((item) => item.type === "text");
		return output?.type === "text" ? output.text : "";
	} finally {
		await runtime?.close();
		if (previousAgentDir === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
		else process.env.RIEMANN_CODING_AGENT_DIR = previousAgentDir;
	}
}

test.skipIf(process.platform !== "linux" || !existsSync(bwrap))(
	"one Agent network policy controls both persistent IPython and shell.run while host operations remain available",
	async () => {
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.end("ok");
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing TCP test address");
		try {
			const allowed = (await executePolicy("allow", address.port)).replace(/\s+/g, " ");
			expect(allowed).toContain(
				"(True, True, {'configured': 'allow', 'effective': 'allow', 'source': 'main'}, True, True)",
			);
			const denied = (await executePolicy("deny", address.port)).replace(/\s+/g, " ");
			expect(denied).toContain(
				"(False, False, {'configured': 'deny', 'effective': 'deny', 'source': 'main'}, True, True)",
			);
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	},
	60_000,
);
