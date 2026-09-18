// token-stats — live prompt-cache hit rate and token speed, in the footer and
// behind `/cache`.
//
// Load it:   cmd --mod ./token-stats.ts
// Or drop the file at ~/.commandcode/mods/token-stats.ts to load it every session.
//
// Reads cache tokens off every `model_request_end` (per-call usage) and refreshes on
// `turn_end`. `usage.inputTokens` is the TOTAL prompt and the cache fields are subsets
// of it, so hit rate = cacheRead / inputTokens (never sum them).
//
// Speed has no timestamp on the event, so it is measured: `model_request_start`
// starts the clock, the first `text_delta`/`thinking_start`/`thinking_delta` gives
// time-to-first-token, and `model_request_end` closes it. The rate is END-TO-END —
// output tokens over the whole call — because that is the only window that is
// actually observable: `usage.outputTokens` covers every generated token, but the
// stream does not announce all of them (tool-call arguments, buffered bursts), so
// any narrower "generation window" under-counts time and fabricates huge rates.
// TTFT is reported separately so prefill latency stays visible.
//
// Totals and timings are snapshotted per turn so the numbers survive `/reload` and
// session resume.

import type {ModApi} from '@commandcode/harness';

const RENDER_TYPE = 'token-stats/report';
const SNAPSHOT_TYPE = 'token-stats/snapshot';

const A = {
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	cyan: '\x1b[36m',
	reset: '\x1b[0m',
} as const;

interface Counters {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	requests: number;
}

interface Speed {
	tokPerSec: number;
	ttftMs: number | null;
}

interface Snapshot {
	totals: Counters;
	perModel: [string, Counters][];
	lastRequest: Counters | null;
	lastModel: string;
	turns: number;
	timedMs: number;
	ttftMs: number;
	timedRequests: number;
	timedOutputTokens: number;
	lastSpeed: Speed | null;
}

interface Report {
	hitRate: number | null;
	input: number;
	read: number;
	write: number;
	uncached: number;
	output: number;
	cache: number;
	requests: number;
	turns: number;
	lastRate: number | null;
	lastModel: string;
	models: {model: string; rate: number | null; read: number; input: number}[];
	lastSpeed: Speed | null;
	sessionTokPerSec: number | null;
	timedRequests: number;
}

function zero(): Counters {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		requests: 0,
	};
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function fromUsage(usage: unknown): Counters {
	const u = (usage ?? {}) as Record<string, unknown>;
	return {
		inputTokens: num(u.inputTokens),
		outputTokens: num(u.outputTokens),
		cacheReadTokens: num(u.cacheReadTokens),
		cacheWriteTokens: num(u.cacheWriteTokens),
		requests: 1,
	};
}

function add(target: Counters, delta: Counters): void {
	target.inputTokens += delta.inputTokens;
	target.outputTokens += delta.outputTokens;
	target.cacheReadTokens += delta.cacheReadTokens;
	target.cacheWriteTokens += delta.cacheWriteTokens;
	target.requests += delta.requests;
}

function uncachedTokens(c: Counters): number {
	return Math.max(0, c.inputTokens - c.cacheReadTokens - c.cacheWriteTokens);
}

function cacheTokens(c: Counters): number {
	return c.cacheReadTokens + c.cacheWriteTokens;
}

// `usage.inputTokens` is the TOTAL prompt (the AI SDK's `inputTokens.total` =
// uncached + cache read + cache write); the cache fields are SUBSETS of it, not
// siblings. So the hit rate is cacheRead ÷ inputTokens — adding the cache fields
// to the denominator would double-count them and halve the rate.
function hitRate(c: Counters): number | null {
	return c.inputTokens > 0 ? c.cacheReadTokens / c.inputTokens : null;
}

function pct(rate: number | null): string {
	return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

function color(rate: number | null): string {
	if (rate === null) return A.dim;
	if (rate >= 0.7) return A.green;
	if (rate >= 0.4) return A.yellow;
	return A.red;
}

function human(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
	return String(Math.round(n));
}

function bar(rate: number | null, width = 12): string {
	if (rate === null) return ' '.repeat(width);
	const filled = Math.max(0, Math.min(width, Math.round(rate * width)));
	return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function fmtSpeed(n: number | null | undefined): string {
	if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '—';
	return n >= 100 ? String(Math.round(n)) : n.toFixed(1);
}

function fmtDuration(ms: number): string {
	if (ms >= 10_000) return `${Math.round(ms / 1000)}s`;
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms)}ms`;
}

function sessionSpeed(outputTokens: number, timedMs: number): number | null {
	return outputTokens > 0 && timedMs > 0 ? outputTokens / (timedMs / 1000) : null;
}

export default function (cmd: ModApi): void {
	let totals = zero();
	let perModel = new Map<string, Counters>();
	let lastRequest: Counters | null = null;
	let lastModel = '—';
	let turns = 0;

	let startedAt = 0;
	let firstOutputAt = 0;
	let lastSpeed: Speed | null = null;
	let timedMs = 0;
	let ttftMs = 0;
	let timedRequests = 0;
	let timedOutputTokens = 0;

	function report(): Report {
		const models = [...perModel.entries()]
			.map(([model, c]) => ({
				model,
				rate: hitRate(c),
				read: c.cacheReadTokens,
				input: c.inputTokens,
			}))
			.sort((a, b) => b.input - a.input);
		return {
			hitRate: hitRate(totals),
			input: totals.inputTokens,
			read: totals.cacheReadTokens,
			write: totals.cacheWriteTokens,
			uncached: uncachedTokens(totals),
			output: totals.outputTokens,
			cache: cacheTokens(totals),
			requests: totals.requests,
			turns,
			lastRate: lastRequest ? hitRate(lastRequest) : null,
			lastModel,
			models,
			lastSpeed,
			sessionTokPerSec: sessionSpeed(timedOutputTokens, timedMs),
			timedRequests,
		};
	}

	function repaint(): void {
		if (totals.requests === 0) return;
		const session = hitRate(totals);
		const avg = sessionSpeed(timedOutputTokens, timedMs);
		const segments = [
			`${A.bold}⛁ cache${A.reset} ${color(session)}${pct(session)}${A.reset}`,
		];
		const speed: string[] = [];
		if (lastSpeed && lastSpeed.tokPerSec > 0) {
			speed.push(`${A.bold}${fmtSpeed(lastSpeed.tokPerSec)} tok/s${A.reset}`);
			if (lastSpeed.ttftMs !== null) {
				speed.push(`${A.dim}ttft ${fmtDuration(lastSpeed.ttftMs)}${A.reset}`);
			}
		}
		if (avg !== null && avg > 0) speed.push(`${A.dim}avg ${fmtSpeed(avg)}${A.reset}`);
		if (speed.length > 0) segments.push(speed.join('  '));
		segments.push(
			`${A.dim}in${A.reset} ${human(totals.inputTokens)}` +
				`  ${A.dim}·${A.reset}  ${A.dim}out${A.reset} ${human(totals.outputTokens)}` +
				`  ${A.dim}·${A.reset}  ${A.dim}cache${A.reset} ${human(cacheTokens(totals))}`,
		);
		cmd.ui.setStatus(segments.join(`  ${A.dim}│${A.reset}  `));
	}

	function restore(snapshot?: Snapshot): void {
		const s = snapshot?.totals;
		totals = {
			inputTokens: num(s?.inputTokens),
			outputTokens: num(s?.outputTokens),
			cacheReadTokens: num(s?.cacheReadTokens),
			cacheWriteTokens: num(s?.cacheWriteTokens),
			requests: num(s?.requests),
		};
		turns = num(snapshot?.turns);
		timedMs = num(snapshot?.timedMs);
		ttftMs = num(snapshot?.ttftMs);
		timedRequests = num(snapshot?.timedRequests);
		timedOutputTokens = num(snapshot?.timedOutputTokens);
		const prev = snapshot?.lastSpeed;
		lastSpeed =
			prev && Number.isFinite(prev.tokPerSec) && prev.tokPerSec > 0
				? {
						tokPerSec: num(prev.tokPerSec),
						ttftMs: prev.ttftMs == null ? null : num(prev.ttftMs),
					}
				: null;
		perModel = new Map(
			(snapshot?.perModel ?? []).map(([model, counters]) => [model, {
				inputTokens: num(counters?.inputTokens),
				outputTokens: num(counters?.outputTokens),
				cacheReadTokens: num(counters?.cacheReadTokens),
				cacheWriteTokens: num(counters?.cacheWriteTokens),
				requests: num(counters?.requests),
			}]),
		);
		const previousRequest = snapshot?.lastRequest;
		lastRequest = previousRequest
			? {
					inputTokens: num(previousRequest.inputTokens),
					outputTokens: num(previousRequest.outputTokens),
					cacheReadTokens: num(previousRequest.cacheReadTokens),
					cacheWriteTokens: num(previousRequest.cacheWriteTokens),
					requests: num(previousRequest.requests),
				}
			: null;
		lastModel = typeof snapshot?.lastModel === 'string' ? snapshot.lastModel : '—';
		startedAt = 0;
		firstOutputAt = 0;
	}

	// ── timing ──────────────────────────────────────────────────────────────────
	// No duration rides the events, so measure it: request start → first output
	// chunk (TTFT) → request end. Only the first chunk is tracked; the rate itself
	// is end-to-end (see the header), so the last chunk is deliberately unused.
	cmd.on('model_request_start', () => {
		startedAt = Date.now();
		firstOutputAt = 0;
	});

	// Any of these is the first token out of the model — thinking counts, otherwise
	// a reasoning-heavy turn would look like it produced nothing until it spoke.
	const markFirstOutput = (): void => {
		if (startedAt > 0 && firstOutputAt === 0) firstOutputAt = Date.now();
	};

	cmd.on('text_delta', markFirstOutput);
	cmd.on('thinking_start', markFirstOutput);
	cmd.on('thinking_delta', markFirstOutput);

	// ── live accounting ─────────────────────────────────────────────────────────
	// model_request_end carries the per-call usage; turn_end closes the round and
	// repaints so the footer is never a request behind.
	cmd.on('model_request_end', event => {
		const usage = fromUsage(event.usage);
		add(totals, usage);
		lastRequest = usage;
		if (typeof event.model === 'string') lastModel = event.model;

		const model = perModel.get(lastModel) ?? zero();
		add(model, usage);
		perModel.set(lastModel, model);

		if (startedAt > 0) {
			const elapsed = Math.max(1, Date.now() - startedAt);
			const ttft = firstOutputAt > 0 ? Math.max(0, firstOutputAt - startedAt) : null;
			lastSpeed = {
				tokPerSec:
					usage.outputTokens > 0 ? usage.outputTokens / (elapsed / 1000) : 0,
				ttftMs: ttft,
			};
			timedMs += elapsed;
			if (ttft !== null) ttftMs += ttft;
			timedRequests += 1;
			timedOutputTokens += usage.outputTokens;
		} else {
			lastSpeed = null;
		}
		startedAt = 0;
		firstOutputAt = 0;

		repaint();
	});

	cmd.on('turn_end', event => {
		turns = typeof event.turnNumber === 'number' ? event.turnNumber : turns + 1;
		repaint();
	});

	// ── durable snapshot, so /reload and resume keep the running totals ─────────
	cmd.hooks({
		onTurnEnd: async ({state}, ctx) => {
			if (totals.requests > 0) {
				ctx?.session?.appendCustomEntry({
					customType: SNAPSHOT_TYPE,
					data: {
						totals: {...totals},
						perModel: [...perModel.entries()].map(
							([model, counters]): [string, Counters] => [model, {...counters}],
						),
						lastRequest: lastRequest ? {...lastRequest} : null,
						lastModel,
						turns,
						timedMs,
						ttftMs,
						timedRequests,
						timedOutputTokens,
						lastSpeed,
					} satisfies Snapshot,
				});
			}
			return state;
		},
	});

	cmd.on('session_start', () => {
		const store = cmd.session;
		if (!store) return;
		let last: Snapshot | undefined;
		try {
			const entries = store.getCustomEntries({customType: SNAPSHOT_TYPE});
			last = entries.length
				? (entries[entries.length - 1]?.data as Snapshot)
				: undefined;
		} catch {
			last = undefined;
		}
		restore(last);
		repaint();
	});

	// ── `/cache` — a styled block in the feed (or one line when headless) ───────
	cmd.addRenderer(RENDER_TYPE, data => {
		const r = data as Report;
		const lines = [
			`${A.bold}${A.cyan}⛁ prompt cache${A.reset}  ${color(r.hitRate)}${pct(r.hitRate)}${A.reset} ${A.dim}session hit rate${A.reset}`,
			`  ${color(r.hitRate)}${bar(r.hitRate)}${A.reset}  ${A.dim}${human(r.read)} read · ${human(r.write)} written · ${human(r.uncached)} uncached${A.reset}`,
			`  ${A.dim}in${A.reset} ${human(r.input)}  ${A.dim}·${A.reset}  ${A.dim}out${A.reset} ${human(r.output)}  ${A.dim}·${A.reset}  ${A.dim}cache${A.reset} ${human(r.cache)}` +
				`  ${A.dim}· ${r.requests} request${r.requests === 1 ? '' : 's'} over ${r.turns} turn${r.turns === 1 ? '' : 's'}${A.reset}`,
		];
		if (r.lastSpeed || r.lastRate !== null) {
			const bits: string[] = [];
			if (r.lastSpeed && r.lastSpeed.tokPerSec > 0) {
				bits.push(
					`${A.bold}${fmtSpeed(r.lastSpeed.tokPerSec)}${A.reset} ${A.dim}tok/s${A.reset}`,
				);
				if (r.lastSpeed.ttftMs !== null) {
					bits.push(`${A.dim}ttft ${fmtDuration(r.lastSpeed.ttftMs)}${A.reset}`);
				}
			}
			if (r.lastRate !== null) {
				bits.push(`${color(r.lastRate)}${pct(r.lastRate)}${A.reset} ${A.dim}cache${A.reset}`);
			}
			lines.push(
				`  ${A.dim}last request (${r.lastModel})${A.reset}  ${bits.join(` ${A.dim}·${A.reset} `)}`,
			);
		}
		if (r.sessionTokPerSec !== null && r.sessionTokPerSec > 0) {
			lines.push(
				`  ${A.dim}session avg${A.reset}  ${A.bold}${fmtSpeed(r.sessionTokPerSec)}${A.reset} ` +
					`${A.dim}tok/s over ${r.timedRequests} request${r.timedRequests === 1 ? '' : 's'}${A.reset}`,
			);
		}
		if (r.models.length > 1) {
			lines.push(`  ${A.dim}by model${A.reset}`);
			for (const m of r.models.slice(0, 5)) {
				lines.push(
					`    ${color(m.rate)}${pct(m.rate).padStart(6)}${A.reset}  ` +
						`${A.dim}${human(m.read)} / ${human(m.input)}${A.reset}  ${m.model}`,
				);
			}
		}
		return lines;
	});

	cmd.addCommand({
		name: 'cache',
		description: 'Show the prompt-cache hit rate, token speed and breakdown',
		handler: () => {
			const r = report();
			if (cmd.ui.capabilities.status) {
				cmd.showEntry(RENDER_TYPE, r);
				return undefined;
			}
			const speed =
				r.lastSpeed && r.lastSpeed.tokPerSec > 0
					? ` · ${fmtSpeed(r.lastSpeed.tokPerSec)} tok/s`
					: '';
			return {
				message:
					`cache hit ${pct(r.hitRate)} — in ${human(r.input)} · out ${human(r.output)} · cache ${human(r.cache)}` +
					` · ${r.requests} request${r.requests === 1 ? '' : 's'}${speed}`,
			};
		},
	});
}
