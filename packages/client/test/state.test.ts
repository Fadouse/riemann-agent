import type { ServiceCall } from "@earendil-works/chord";
import { expect, test } from "vitest";
import { Client } from "../src/index.ts";
import { MemoryByteServer } from "./support.ts";

const serverId = "00000000-0000-4000-8000-000000000001";

test("preserves image detail in opaque service requests", async () => {
	const server = new MemoryByteServer(serverId);
	const client = await Client.connect({
		serverId,
		transportFactory: (handlers) => server.connect(handlers),
	});
	const call = {
		serviceId: "pi.agent-controller",
		member: "prompt",
		args: [
			{
				message: "inspect",
				images: [{ type: "image", data: "cG5n", mimeType: "image/png", detail: "high" }],
			},
		],
	} satisfies ServiceCall;

	const pending = client.request({ serverId }, call);
	await server.waitForMessages(2);
	expect(server.messages[1]).toEqual({
		type: "request",
		id: "request-1",
		target: { serverId },
		call,
	});
	server.send({ type: "response", id: "request-1", ok: true, result: null });
	await expect(pending).resolves.toBeNull();
	await client.dispose();
});
