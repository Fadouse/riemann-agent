import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { Agent, fetch as undiciFetch } from "undici";
import { graphemeSafePrefix } from "../../utils/text.ts";
import { RiemannHostError } from "../errors.ts";
import { type JsonValue, kernelHostResult } from "../kernel/types.ts";
import { utf8Prefix } from "../output.ts";
import type { ArtifactStore } from "../state/artifacts.ts";
import { PageStore, pageSchema } from "../state/pages.ts";
import type { FunctionDefinition } from "./registry.ts";

const MAX_REDIRECTS = 10;
const PRIVATE_NETWORKS = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	PRIVATE_NETWORKS.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const)
	PRIVATE_NETWORKS.addSubnet(address, prefix, "ipv6");

type ResolveHostname = (hostname: string) => Promise<string[]>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
const ISO_TIMESTAMP_PATTERN =
	"^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$";

const ArtifactSchema = Type.Object(
	{
		$riemann: Type.Literal("artifact"),
		handle: Type.String(),
		mime_type: Type.String(),
		size: Type.Integer({ minimum: 0 }),
		name: Type.Union([Type.String(), Type.Null()]),
	},
	{ additionalProperties: false, $id: "Artifact" },
);

const SearchHitSchema = Type.Object(
	{
		$riemann: Type.Literal("search_hit"),
		title: Type.String(),
		url: Type.String(),
		snippet: Type.String(),
		snippet_truncated: Type.Boolean(),
		published_at: Type.Union([Type.String(), Type.Null()]),
	},
	{ additionalProperties: false, $id: "SearchHit" },
);

const DocumentSchema = Type.Object(
	{
		$riemann: Type.Literal("document"),
		url: Type.String(),
		title: Type.Union([Type.String(), Type.Null()]),
		text: Type.String(),
		text_truncated: Type.Boolean(),
		artifact_kind: Type.Union([Type.Literal("raw"), Type.Literal("extracted"), Type.Literal("prefix"), Type.Null()]),
		content_type: Type.String(),
		artifact: Type.Union([ArtifactSchema, Type.Null()]),
		trust: Type.Literal("untrusted"),
	},
	{ additionalProperties: false, $id: "Document" },
);

const ExaResponseSchema = Type.Object({
	results: Type.Array(
		Type.Object(
			{
				id: Type.String(),
				url: Type.String(),
				title: Type.Union([Type.String(), Type.Null()]),
				publishedDate: Type.Optional(Type.String()),
				highlights: Type.Optional(Type.Array(Type.String())),
				text: Type.Optional(Type.String()),
			},
			{ additionalProperties: true },
		),
	),
});
type ExaResponse = Static<typeof ExaResponseSchema>;

function requiredString(args: Record<string, JsonValue>, name: string): string {
	const value = args[name];
	if (typeof value !== "string" || value.trim().length === 0)
		throw new RiemannHostError("invalid_arguments", `${name} must be a non-empty string`);
	return value;
}

function parseUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new RiemannHostError("invalid_arguments", `Invalid URL: ${value}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new RiemannHostError("invalid_arguments", "URL must use HTTP or HTTPS");
	return url;
}

function normalizeProviderUrl(value: string): string {
	try {
		return parseUrl(value).toString();
	} catch {
		throw new RiemannHostError("provider_error", "Exa returned an invalid result URL");
	}
}

function normalizeDomains(value: JsonValue | undefined): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.length === 0) {
		throw new RiemannHostError("invalid_arguments", "domains must be a non-empty list of domain names");
	}
	const normalized: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.length > 253 || item !== item.trim() || /[\s/:?#@]/u.test(item)) {
			throw new RiemannHostError("invalid_arguments", "domains must contain only domain names");
		}
		let hostname: string;
		try {
			hostname = new URL(`http://${item}`).hostname.toLowerCase();
		} catch {
			throw new RiemannHostError("invalid_arguments", `Invalid domain: ${item}`);
		}
		const labels = hostname.split(".");
		if (
			isIP(hostname) !== 0 ||
			labels.length < 2 ||
			labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
		) {
			throw new RiemannHostError("invalid_arguments", `Invalid domain: ${item}`);
		}
		normalized.push(hostname);
	}
	return [...new Set(normalized)];
}

function normalizeSince(value: JsonValue | undefined): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string")
		throw new RiemannHostError("invalid_arguments", "since must be an ISO 8601 timestamp string");
	const match = new RegExp(ISO_TIMESTAMP_PATTERN, "u").exec(value);
	if (!match) throw new RiemannHostError("invalid_arguments", "since must be a valid ISO 8601 timestamp");
	const year = Number(value.slice(0, 4));
	const month = Number(match[1]);
	const day = Number(match[2]);
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
	const offsetHours = match[6] === undefined ? 0 : Number(match[6]);
	const offsetMinutes = value.endsWith("Z") ? 0 : Number(value.slice(-2));
	const date = new Date(value);
	if (
		day > daysInMonth ||
		offsetHours > 14 ||
		(offsetHours === 14 && offsetMinutes !== 0) ||
		Number.isNaN(date.getTime())
	) {
		throw new RiemannHostError("invalid_arguments", "since must be a valid ISO 8601 timestamp");
	}
	return date.toISOString();
}

function decodeBody(data: Uint8Array, contentType: string | null): string | undefined {
	const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(contentType ?? "");
	const charset = match?.[1] || match?.[2] || match?.[3];
	if (charset) {
		try {
			return new TextDecoder(charset, { fatal: true, ignoreBOM: true }).decode(data);
		} catch {}
	}
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
	} catch {
		return undefined;
	}
}

async function* responseChunks(response: Response): AsyncGenerator<Uint8Array> {
	if (!response.body) return;
	const reader = response.body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

function responseError(body: string): string {
	return graphemeSafePrefix(body.replace(/\s+/g, " ").trim(), 500) || "empty response";
}

function readableHtml(html: string, finalUrl: string): { title: string | null; text: string } {
	const parsed = parseHTML(html);
	const document = parsed.document;
	const removableNodes = document.querySelectorAll(
		"script,style,iframe,object,embed,form,noscript",
	) as unknown as Iterable<{ remove(): void }>;
	for (const node of removableNodes) node.remove();
	const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse();
	const title = article?.title?.replace(/\s+/g, " ").trim() || document.title?.trim() || null;
	const text = (article?.textContent || document.body?.textContent || "")
		.replace(/[ \t\u00a0]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title, text: text || finalUrl };
}

function isTextContentType(contentType: string): boolean {
	return (
		contentType.startsWith("text/") ||
		contentType === "application/json" ||
		contentType.endsWith("+json") ||
		contentType === "application/xml" ||
		contentType.endsWith("+xml") ||
		contentType === "application/javascript"
	);
}

async function requestWithNormalizedErrors<T>(
	operation: string,
	callerSignal: AbortSignal,
	request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	if (callerSignal.aborted) throw new RiemannHostError("cancelled", `${operation} was cancelled`);
	try {
		return await request(callerSignal);
	} catch (error) {
		if (error instanceof RiemannHostError) throw error;
		if (callerSignal.aborted) throw new RiemannHostError("cancelled", `${operation} was cancelled`);
		throw new RiemannHostError("network_error", `${operation} failed`, undefined, true);
	}
}

export class WebFunctions {
	private readonly exaApiKey: string | undefined;
	private readonly artifacts: ArtifactStore;
	private readonly previewBytes: number;
	private readonly resolveHostname: ResolveHostname;
	private readonly dispatcher: Agent | undefined;
	private readonly fetcher: Fetcher;
	private readonly pages: PageStore;

	constructor(
		exaApiKey: string | undefined,
		artifacts: ArtifactStore,
		previewBytes: number,
		resolveHostname: ResolveHostname = async (hostname) =>
			(await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address),
		fetcher?: Fetcher,
		pages?: PageStore,
	) {
		this.pages = pages ?? new PageStore(artifacts, randomUUID());
		this.exaApiKey = exaApiKey;
		this.artifacts = artifacts;
		this.previewBytes = previewBytes;
		this.resolveHostname = resolveHostname;
		if (fetcher) {
			this.fetcher = fetcher;
		} else {
			this.dispatcher = new Agent({
				connect: {
					autoSelectFamily: false,
					lookup: (hostname, _options, callback) => {
						void this.resolveHostname(hostname).then(
							(addresses) => {
								try {
									this.assertPublicAddresses(addresses);
									const address = addresses[0];
									if (!address) throw new Error(`Could not resolve ${hostname}`);
									callback(null, address, isIP(address));
								} catch (error) {
									callback(error instanceof Error ? error : new Error(String(error)), "", 4);
								}
							},
							(error) => callback(error instanceof Error ? error : new Error(String(error)), "", 4),
						);
					},
				},
			});
			this.fetcher = async (input, init) =>
				(await undiciFetch(input, {
					...(init as NonNullable<Parameters<typeof undiciFetch>[1]>),
					dispatcher: this.dispatcher,
				})) as unknown as Response;
		}
	}

	private assertPublicAddresses(addresses: readonly string[]): void {
		if (addresses.length === 0) throw new RiemannHostError("network_error", "Hostname resolved to no addresses");
		for (const address of addresses) {
			const family = isIP(address);
			const normalized = family === 6 && address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
			const normalizedFamily = isIP(normalized);
			if (normalizedFamily === 0 || PRIVATE_NETWORKS.check(normalized, normalizedFamily === 6 ? "ipv6" : "ipv4")) {
				throw new RiemannHostError("permission_denied", `URL resolves to a non-public address: ${address}`);
			}
		}
	}

	private async assertPublicDestination(url: URL): Promise<void> {
		const addresses = isIP(url.hostname) ? [url.hostname] : await this.resolveHostname(url.hostname);
		this.assertPublicAddresses(addresses);
	}

	private async fetchPublic(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
		let current = url;
		for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
			signal.throwIfAborted();
			await this.assertPublicDestination(current);
			signal.throwIfAborted();
			const response = await this.fetcher(current, { ...init, redirect: "manual", signal });
			if (![301, 302, 303, 307, 308].includes(response.status)) return response;
			const location = response.headers.get("location");
			await this.retainBody(response, "web-redirect");
			if (!location) throw new RiemannHostError("network_error", "Redirect response omitted Location");
			if (redirects === MAX_REDIRECTS) throw new RiemannHostError("network_error", "Too many redirects");
			current = parseUrl(new URL(location, current).toString());
		}
		throw new RiemannHostError("network_error", "Too many redirects");
	}

	private async retainBody(response: Response, name: string): Promise<{ data: Buffer; ref: string }> {
		const artifact = await this.artifacts.putStream(responseChunks(response), {
			name,
			mimeType: "application/octet-stream",
			detectText: true,
		});
		if (
			typeof artifact !== "object" ||
			artifact === null ||
			Array.isArray(artifact) ||
			typeof artifact.handle !== "string"
		)
			throw new RiemannHostError("artifact_error", "HTTP response has no retained reference");
		return { data: await this.artifacts.readBuffer(artifact.handle), ref: artifact.handle };
	}

	async close(): Promise<void> {
		await this.dispatcher?.close();
	}

	definitions(): FunctionDefinition[] {
		return [
			{
				name: "search",
				namespace: "web",
				description:
					"Search the current web with Exa and return stable SearchHit objects with excerpts and source URLs.",
				inputSchema: Type.Object(
					{
						query: Type.String({
							minLength: 1,
							pattern: ".*\\S.*",
							description: "Search query",
						}),
						result_count: Type.Optional(
							Type.Union([Type.Integer({ minimum: 1, maximum: 30 }), Type.Null()], {
								description: "Result count from 1 to 30",
								default: 10,
							}),
						),
						domains: Type.Optional(
							Type.Union(
								[
									Type.Array(
										Type.String({
											minLength: 1,
											maxLength: 253,
											pattern: "^[^\\s/:?#@]+$",
										}),
										{ minItems: 1 },
									),
									Type.Null(),
								],
								{ description: "Domain-name allowlist" },
							),
						),
						since: Type.Optional(
							Type.Union([Type.String({ pattern: ISO_TIMESTAMP_PATTERN }), Type.Null()], {
								description: "ISO 8601 timestamp lower bound",
							}),
						),
					},
					{ additionalProperties: false },
				),
				outputSchema: pageSchema(SearchHitSchema),
				pythonReturnType: "Page[SearchHit]",
				errors: [
					{
						code: "limit_exceeded",
						description: "The run has exhausted its resource reference numbers.",
						retryable: false,
					},
					{ code: "artifact_error", description: "The result snapshot artifact is invalid.", retryable: false },
					{
						code: "invalid_arguments",
						description: "The query or search filters are invalid.",
						retryable: false,
					},
					{
						code: "not_configured",
						description: "The Exa API key is not configured.",
						retryable: false,
					},
					{
						code: "network_error",
						description: "The Exa request could not be completed.",
						retryable: true,
					},
					{
						code: "provider_error",
						description: "Exa returned an HTTP or response-shape error; only HTTP 429 and 5xx permit retry.",
						retryable: false,
					},
					{
						code: "cancelled",
						description: "The caller cancelled the search.",
						retryable: false,
					},
				],
				effects: [
					{ kind: "read", resource: "external-network" },
					{ kind: "write", resource: "artifact-store" },
				],
				idempotency: "idempotent",
				cancellation: {
					supported: true,
					description: "Aborting cancels the in-flight Exa request.",
				},
				visibility: "public",
				prompt: {
					inventory: "Search the current web with excerpts and source URLs.",
					example:
						"hits = await web.search(query='Node.js sqlite DatabaseSync documentation', result_count=5); output.show(value=hits)",
				},
				capability: "web.search",
				handler: async (args, signal) => {
					if (signal.aborted) throw new RiemannHostError("cancelled", "Web request was cancelled");
					const exaApiKey = this.exaApiKey;
					if (!exaApiKey)
						throw new RiemannHostError(
							"not_configured",
							`Exa is not configured. Set web.exaApiKey in ~/.riemann/agent/config.yaml, preferably as \${EXA_API_KEY}.`,
						);
					const query = requiredString(args, "query");
					const limit = args.result_count === undefined || args.result_count === null ? 10 : args.result_count;
					if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 30) {
						throw new RiemannHostError("invalid_arguments", "result_count must be an integer from 1 to 30");
					}
					const domains = normalizeDomains(args.domains);
					const since = normalizeSince(args.since);
					const retained = await requestWithNormalizedErrors("Exa search", signal, async (requestSignal) => {
						const response = await this.fetcher("https://api.exa.ai/search", {
							method: "POST",
							headers: {
								accept: "application/json",
								"content-type": "application/json",
								"x-api-key": exaApiKey,
							},
							redirect: "error",
							body: JSON.stringify({
								query,
								type: "auto",
								numResults: limit,
								...(domains ? { includeDomains: domains } : {}),
								...(since ? { startPublishedDate: since } : {}),
								contents: { highlights: { query } },
							}),
							signal: requestSignal,
						});
						const retained = await this.retainBody(response, "web-search.json");
						const responseBody = retained.data.toString("utf8");
						if (!response.ok) {
							throw new RiemannHostError(
								"provider_error",
								`Exa search failed with HTTP ${response.status}: ${responseError(responseBody)}`,
								{ status: response.status, ref: retained.ref },
								response.status === 429 || response.status >= 500,
								response.status === 429 || response.status >= 500
									? "retry"
									: response.status === 401 || response.status === 403
										? "reauthorize"
										: "fix_arguments",
							);
						}
						return retained;
					});
					let parsed: unknown;
					try {
						parsed = JSON.parse(retained.data.toString("utf8"));
					} catch {
						throw new RiemannHostError("provider_error", "Exa returned invalid JSON", { ref: retained.ref });
					}
					if (!Value.Check(ExaResponseSchema, parsed))
						throw new RiemannHostError("provider_error", "Exa response has an invalid result shape", {
							ref: retained.ref,
						});
					const result = parsed as ExaResponse;
					const items = result.results.map((item) => {
						const source = item.highlights?.join("\n\n") || item.text || "";
						return {
							$riemann: "search_hit",
							title: item.title ?? item.url,
							url: normalizeProviderUrl(item.url),
							snippet: source,
							snippet_truncated: false,
							published_at: item.publishedDate ?? null,
						};
					});
					return kernelHostResult(await this.pages.create("web.search", items, { coverage: "unknown" }), [
						{ type: "text", text: `[source web.search ${retained.ref}]` },
					]);
				},
			},
			{
				name: "fetch",
				namespace: "web",
				description:
					"Fetch an HTTP(S) URL. HTML is reduced to readable text; large or binary bodies are stored as durable artifacts.",
				inputSchema: Type.Object(
					{ url: Type.String({ minLength: 1, description: "HTTP(S) URL" }) },
					{ additionalProperties: false },
				),
				outputSchema: DocumentSchema,
				pythonReturnType: "Document",
				errors: [
					{
						code: "limit_exceeded",
						description: "The run has exhausted its resource reference numbers.",
						retryable: false,
					},
					{
						code: "permission_denied",
						description: "The URL or redirect resolves to a non-public address.",
						retryable: false,
					},
					{
						code: "invalid_arguments",
						description: "The URL is invalid or is not HTTP(S).",
						retryable: false,
					},
					{
						code: "network_error",
						description: "The resource could not be fetched.",
						retryable: true,
					},
					{
						code: "cancelled",
						description: "The caller cancelled the fetch.",
						retryable: false,
					},
				],
				effects: [
					{ kind: "read", resource: "external-network" },
					{ kind: "write", resource: "artifact-store" },
				],
				idempotency: "idempotent",
				cancellation: {
					supported: true,
					description: "Aborting cancels the in-flight HTTP request.",
				},
				visibility: "public",
				prompt: {
					inventory: "Fetch an HTTP(S) resource; large and binary bodies become durable artifacts.",
					example: "document = await web.fetch(url='https://example.com'); output.show(value=document)",
				},
				capability: "web.fetch",
				handler: async (args, signal) => {
					if (signal.aborted) throw new RiemannHostError("cancelled", "Web request was cancelled");
					const url = parseUrl(requiredString(args, "url"));
					const { response, data, ref } = await requestWithNormalizedErrors(
						"Fetch",
						signal,
						async (requestSignal) => {
							const fetched = await this.fetchPublic(
								url,
								{
									headers: {
										accept: "text/html,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1",
										"user-agent": "Riemann-Agent/0.1",
									},
								},
								requestSignal,
							);
							const retained = await this.retainBody(fetched, "web-response");
							if (!fetched.ok) {
								throw new RiemannHostError(
									"network_error",
									`Fetch failed with HTTP ${fetched.status} ${fetched.statusText}`.trim(),
									{ status: fetched.status, ref: retained.ref },
									fetched.status === 429 || fetched.status >= 500,
									fetched.status === 429 || fetched.status >= 500
										? "retry"
										: fetched.status === 401 || fetched.status === 403
											? "reauthorize"
											: "fix_arguments",
								);
							}
							return { response: fetched, ...retained };
						},
					);
					const contentType =
						response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ??
						"application/octet-stream";
					const finalUrl = response.url || url.toString();
					const source = isTextContentType(contentType)
						? decodeBody(data, response.headers.get("content-type"))
						: undefined;
					if (source === undefined) {
						const artifact = await this.artifacts.putBuffer(data, {
							name: "web-fetch.bin",
							mimeType: isTextContentType(contentType) ? "application/octet-stream" : contentType,
						});
						return {
							$riemann: "document",
							url: finalUrl,
							title: null,
							text: "",
							text_truncated: false,
							artifact_kind: "raw",
							content_type: contentType,
							artifact,
							trust: "untrusted",
						};
					}
					let extracted: { title: string | null; text: string };
					try {
						extracted = contentType.includes("html")
							? readableHtml(source, finalUrl)
							: { title: null, text: source };
					} catch (error) {
						throw new RiemannHostError("parse_error", `Response retained at ${ref}: ${String(error)}`, { ref });
					}
					const textTruncated = Buffer.byteLength(extracted.text) > this.previewBytes;
					const artifact = textTruncated
						? await this.artifacts.putText(extracted.text, {
								name: "web-fetch.txt",
								mimeType: "text/plain; charset=utf-8",
							})
						: null;
					return kernelHostResult(
						{
							$riemann: "document",
							url: finalUrl,
							title: extracted.title,
							text: utf8Prefix(extracted.text, this.previewBytes),
							text_truncated: textTruncated,
							artifact_kind: artifact ? "extracted" : null,
							content_type: contentType,
							artifact,
							trust: "untrusted",
						},
						[{ type: "text", text: `[source web.fetch ${ref}]` }],
					);
				},
			},
		];
	}
}
