/**
 * Regression test for the compaction KV-cache optimization: the summarization request
 * must reuse the live session prompt prefix, i.e. its wire-level payload (system prompt,
 * tool declarations, history messages) must be a strict prefix of the most recent live
 * request payload, so serving-side prefix KV caches can be reused instead of
 * re-prefilling the summarized history.
 *
 * The comparison happens at the HTTP wire level: a local mock OpenAI/Anthropic server
 * captures the exact JSON payloads, which is what the provider's prefix cache keys on.
 */
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

type Mode = "text" | "toolcall" | "image" | "toolchange" | "twice" | "anthropic";

interface WireRequest {
	model: string;
	messages: Array<{ role: string; content: unknown; [k: string]: unknown }>;
	tools?: unknown;
	[key: string]: unknown;
}

interface MockServer {
	port: number;
	captured: WireRequest[];
	close: () => Promise<void>;
}

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

async function startMockServer(mode: Mode): Promise<MockServer> {
	const captured: WireRequest[] = [];
	const server = http.createServer(async (req, res) => {
		if (req.method !== "POST") {
			res.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of req) body += chunk.toString();
		captured.push(JSON.parse(body) as WireRequest);

		if (mode === "anthropic") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(
				`event: message_start\ndata: ${JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						content: [],
						model: "mock-model",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				})}\n\n`,
			);
			res.write(
				`event: content_block_start\ndata: ${JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				})}\n\n`,
			);
			res.write(
				`event: content_block_delta\ndata: ${JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "ok" },
				})}\n\n`,
			);
			res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
			res.write(
				`event: message_delta\ndata: ${JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { input_tokens: 10, output_tokens: 1 },
				})}\n\n`,
			);
			res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
			res.end();
			return;
		}

		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const write = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
		// First request of the toolcall scenario: reply with a tool call so the
		// session history contains an assistant tool call plus a tool result.
		if (mode === "toolcall" && captured.length === 1) {
			write({
				id: "c1",
				object: "chat.completion.chunk",
				created: 0,
				model: "mock-model",
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read", arguments: JSON.stringify({ path: "hello.txt" }) },
								},
							],
						},
						finish_reason: null,
					},
				],
			});
			write({
				id: "c1",
				object: "chat.completion.chunk",
				created: 0,
				model: "mock-model",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
			});
			res.write("data: [DONE]\n\n");
			res.end();
			return;
		}
		write({
			id: `c${captured.length}`,
			object: "chat.completion.chunk",
			created: 0,
			model: "mock-model",
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
		});
		write({
			id: `c${captured.length}`,
			object: "chat.completion.chunk",
			created: 0,
			model: "mock-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
		});
		res.write("data: [DONE]\n\n");
		res.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		port: (server.address() as AddressInfo).port,
		captured,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}

/** Output-side request params that do not participate in the prompt prefix. */
function stripOutputParams(request: WireRequest): Record<string, unknown> {
	const {
		max_tokens: _mt,
		max_completion_tokens: _mct,
		max_tokens_limit: _mcl,
		prompt_cache_key: _pck,
		prompt_cache_retention: _pcr,
		...rest
	} = request;
	return rest;
}

/** Strip Anthropic cache_control markers, which are write-side cache metadata. */
function stripCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripCacheControl);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (key === "cache_control") continue;
			out[key] = stripCacheControl(entry);
		}
		return out;
	}
	return value;
}

/**
 * Run a session against the mock server: a few live turns (per scenario), then a manual
 * compaction, and return the captured wire requests.
 */
async function runScenario(mode: Mode): Promise<WireRequest[]> {
	const mock = await startMockServer(mode);
	const tempDir = join(tmpdir(), `pi-wire-parity-${mode}-${Date.now()}`);
	mkdirSync(tempDir, { recursive: true });
	writeFileSync(join(tempDir, "hello.txt"), "hello world\n");

	const api = mode === "anthropic" ? "anthropic-messages" : "openai-completions";
	const modelsPath = join(tempDir, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				mock: {
					baseUrl: `http://127.0.0.1:${mock.port}/v1`,
					api,
					apiKey: "mock-key",
					models: [
						{
							id: "mock-model",
							name: "Mock Model",
							reasoning: false,
							input: mode === "image" ? ["text", "image"] : ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 8192,
						},
					],
				},
			},
		}),
	);

	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("mock", async () => ({ type: "api_key", key: "mock-key" }));
	const modelRegistry = await createModelRegistry(authStorage, modelsPath);
	const model = modelRegistry.find("mock", "mock-model");
	if (!model) throw new Error("mock model not registered");

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir: join(tempDir, "agent"),
		model,
		modelRuntime: getModelRuntime(modelRegistry),
		sessionManager: SessionManager.inMemory(tempDir),
		settingsManager: SettingsManager.inMemory({
			compaction: { reserveTokens: 2048, keepRecentTokens: 25 },
		}),
	});

	const longText = (topic: string) =>
		`please write a short note about ${topic}, mention the details and keep the answer brief`;
	try {
		if (mode === "toolcall") {
			await session.prompt("please read hello.txt and then tell me what it says");
			await session.prompt(longText("the afternoon and the sunshine"));
		} else if (mode === "toolchange") {
			await session.prompt(longText("the morning and the weather"));
			session.setActiveToolsByName(["read"]);
			await session.prompt(longText("the afternoon and the sunshine"));
		} else if (mode === "twice") {
			await session.prompt(longText("the morning and the weather"));
			await session.prompt(longText("the noon and the heat"));
			await session.compact();
			await session.prompt(longText("the evening and the stars"));
		} else if (mode === "image") {
			await session.prompt("first: a short greeting about the morning", {
				images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
			});
			await session.prompt(longText("the weather and the clouds"));
		} else {
			await session.prompt(longText("the morning and the weather"));
			await session.prompt(longText("the afternoon and the sunshine"));
		}
		if (mode !== "twice") {
			await session.prompt(longText("the evening and the stars"));
		}

		const result = await session.compact();
		expect(result.summary).toBeTruthy();
	} finally {
		session.dispose();
	}

	const requests = mock.captured;
	await mock.close();
	rmSync(tempDir, { recursive: true, force: true });
	return requests;
}

/**
 * Assert that the compaction request (last captured request) reuses the live prefix:
 * its payload minus the trailing summarization instruction must equal a strict prefix of
 * the most recent live request's payload.
 */
function expectPrefixParity(mode: Mode, requests: WireRequest[]): void {
	expect(requests.length).toBeGreaterThanOrEqual(3);
	const live = requests.slice(0, -1);
	const lastLive = live[live.length - 1];
	const sum = requests[requests.length - 1];

	// The final message is the appended summarization instruction.
	expect(sum.messages.length).toBeGreaterThanOrEqual(1);
	const lastMessage = sum.messages[sum.messages.length - 1];
	expect(lastMessage.role).toBe("user");
	const lastContent = JSON.stringify(lastMessage.content);
	expect(lastContent).toContain("structured summary");

	const sumPrefix = sum.messages.slice(0, -1);
	let n = 0;
	while (n < sumPrefix.length && n < lastLive.messages.length) {
		if (JSON.stringify(sumPrefix[n]) !== JSON.stringify(lastLive.messages[n])) break;
		n++;
	}
	// The whole prefix must match the live request message-for-message.
	expect(n).toBe(sumPrefix.length);
	expect(n).toBeGreaterThanOrEqual(1);

	const strip = (value: unknown) => (mode === "anthropic" ? stripCacheControl(value) : value);
	const sumBody = strip({ ...stripOutputParams(sum), messages: sum.messages.slice(0, -1) });
	const liveBody = strip({ ...stripOutputParams(lastLive), messages: lastLive.messages.slice(0, n) });
	expect(JSON.stringify(sumBody)).toBe(JSON.stringify(liveBody));
}

describe("compaction reuses the live session prompt prefix at the wire level", () => {
	it("text-only history", async () => {
		expectPrefixParity("text", await runScenario("text"));
	});

	it("history containing a tool call and tool result", async () => {
		expectPrefixParity("toolcall", await runScenario("toolcall"));
	});

	it("history containing an image (resize path)", async () => {
		expectPrefixParity("image", await runScenario("image"));
	});

	it("history containing a mid-conversation tool loadout change", async () => {
		expectPrefixParity("toolchange", await runScenario("toolchange"));
	});

	it("second compaction (summary replay prefix)", async () => {
		const requests = await runScenario("twice");
		// First compaction is requests[2]; the live request right before it is requests[1].
		expectPrefixParity("twice", requests.slice(0, 3));
		expectPrefixParity("twice", requests);
	});

	it("anthropic-messages wire format (cache_control markers differ by design)", async () => {
		expectPrefixParity("anthropic", await runScenario("anthropic"));
	});
});
