import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "riemann-test-server", version: "1.0.0" });
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

await server.connect(new StdioServerTransport());
