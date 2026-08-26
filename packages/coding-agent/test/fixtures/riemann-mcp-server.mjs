import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "riemann-test-server", version: "1.0.0" });
const PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
server.registerTool(
	"sum-values",
	{
		description: "Add two numbers.",
		inputSchema: { left: z.number(), right: z.number() },
	},
	async ({ left, right }) => ({
		content: [{ type: "text", text: String(left + right) }],
		structuredContent: { total: left + right },
	}),
);

server.registerTool(
	"close",
	{ description: "Tool name colliding with namespace lifecycle.", inputSchema: {} },
	async () => ({ content: [{ type: "text", text: "tool close" }] }),
);

server.registerTool(
	"_private",
	{ description: "Tool name colliding with namespace internals.", inputSchema: {} },
	async () => ({ content: [{ type: "text", text: "private" }] }),
);

server.registerTool(
	"fail",
	{
		description: "Return an MCP tool error.",
		inputSchema: {},
	},
	async () => ({
		isError: true,
		content: [{ type: "text", text: "fixture failure" }],
	}),
);

server.registerTool(
	"show-pixel",
	{
		description: "Return a one-pixel PNG.",
		inputSchema: {},
	},
	async () => ({
		content: [
			{
				type: "image",
				data: PIXEL_PNG,
				mimeType: "image/png",
			},
		],
	}),
);

server.registerTool(
	"show-resource-pixel",
	{
		description: "Return a one-pixel PNG as an embedded resource.",
		inputSchema: {},
	},
	async () => ({
		content: [
			{
				type: "resource",
				resource: {
					uri: "fixture://pixel.png",
					blob: PIXEL_PNG,
					mimeType: "image/png",
					_meta: { fixture: true },
				},
			},
		],
	}),
);

await server.connect(new StdioServerTransport());
