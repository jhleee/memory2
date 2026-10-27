import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { OpenRouterDecisionProvider, DEFAULT_OPENROUTER_DECISION_MODEL } from '../src/openrouter.js';
import { buildWorldContextProbe, type WorldProbePosition } from './world-context-probes.js';

const CHARACTERS = 64_000 as const;
const SEED = 20261005;
const POSITIONS: WorldProbePosition[] = ['start','middle','end'];
const OUTPUT = resolve('evaluation/world-context-64000-result.json');
const sleep = (ms: number) => new Promise<void>(resolveSleep => setTimeout(resolveSleep, ms));

interface Telemetry { status: number | null; latency_ms: number; model: string; cost: number | null }

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorStatus(error: unknown): number | null {
  const match = error instanceof Error ? /HTTP (\d{3})/.exec(error.message) : null;
  return match ? Number(match[1]) : null;
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAPIKEY;
  if (!apiKey) throw new Error('Set OPENROUTER_API_KEY before running this benchmark.');

  const telemetry: Telemetry[] = [];
  const measuredFetch: typeof fetch = async (input, init) => {
    const start = performance.now();
    try {
      const response = await fetch(input, init);
      const entry: Telemetry = { status: response.status, latency_ms: Math.round(performance.now() - start), model: DEFAULT_OPENROUTER_DECISION_MODEL, cost: null };
      try {
        const payload = await response.clone().json() as { model?: unknown; usage?: { cost?: unknown }; cost?: unknown };
        if (typeof payload.model === 'string' && payload.model.length <= 160 && !payload.model.includes(apiKey)) entry.model = payload.model;
        entry.cost = numeric(payload.usage?.cost) ?? numeric(payload.cost);
      } catch { /* Do not retain provider response text. */ }
      telemetry.push(entry);
      return response;
    } catch (error) {
      telemetry.push({ status: null, latency_ms: Math.round(performance.now() - start), model: DEFAULT_OPENROUTER_DECISION_MODEL, cost: null });
      throw error;
    }
  };

  const probes = Object.freeze(POSITIONS.map(position => buildWorldContextProbe({ characters: CHARACTERS, position, seed: SEED })));
  if (new Set(probes.map(probe => probe.metadata.core_hash)).size !== 1 || new Set(probes.map(probe => probe.metadata.padding_hash)).size !== 1) throw new Error('Probe manifests do not share identical core and padding.');
  const manifest = probes.map(probe => Object.freeze({ id: probe.id, state: probe.state, questions: probe.questions, expected_answers: probe.expected_answers, metadata: probe.metadata }));
  Object.freeze(manifest);

  const provider = new OpenRouterDecisionProvider({ apiKey, model: DEFAULT_OPENROUTER_DECISION_MODEL, timeoutMs: 90_000, fetch: measuredFetch });
  const calls: Array<Record<string, unknown>> = [];
  for (let index = 0; index < manifest.length; index++) {
    if (index > 0) await sleep(3_500);
    const probe = manifest[index]!;
    const telemetryStart = telemetry.length;
    const clockStart = performance.now();
    try {
      const answers = await provider.decide(probe.state, probe.questions);
      const callTelemetry = telemetry.slice(telemetryStart).at(-1) ?? { status: null, latency_ms: Math.round(performance.now() - clockStart), model: DEFAULT_OPENROUTER_DECISION_MODEL, cost: null };
      const choices = Object.fromEntries(Object.entries(answers).map(([question, answer]) => [question, answer.type === 'choice' ? answer.choice : null]));
      const evaluated = Object.values(answers).every(answer => answer.type === 'choice');
      const matches = evaluated ? Object.fromEntries(Object.entries(choices).map(([question, choice]) => [question, choice === probe.expected_answers[question]])) : null;
      calls.push({ probe_id: probe.id, position: probe.metadata.position, telemetry: callTelemetry, status: callTelemetry.status, unevaluated: callTelemetry.status === 422, choices, matches, evaluated });
    } catch (error) {
      const callTelemetry = telemetry.slice(telemetryStart).at(-1) ?? { status: errorStatus(error), latency_ms: Math.round(performance.now() - clockStart), model: DEFAULT_OPENROUTER_DECISION_MODEL, cost: null };
      const status = callTelemetry.status ?? errorStatus(error);
      calls.push({ probe_id: probe.id, position: probe.metadata.position, telemetry: { ...callTelemetry, status }, status, unevaluated: status === 422, error_kind: status !== null && status >= 400 ? 'http_error' : 'network_or_response_error', choices: null, matches: null, evaluated: false });
    }
  }

  const report = {
    schema: 'context-memory.world-context-benchmark.v1',
    created_at: new Date().toISOString(),
    configured_model: DEFAULT_OPENROUTER_DECISION_MODEL,
    characters: CHARACTERS,
    seed: SEED,
    pacing_ms: 3_500,
    timeout_ms: 90_000,
    manifest: manifest.map(({ id, expected_answers, metadata, questions }) => ({ id, expected_answers, metadata, questions })),
    calls,
    network: telemetry,
    status: calls.every(call=>call.evaluated)?'complete':'service_rejected',
    summary: {
      calls: calls.length,
      evaluated: calls.filter(call => call.evaluated).length,
      unevaluated: calls.filter(call => call.unevaluated).length,
      correct_answers: calls.reduce((sum, call) => sum + (call.matches ? Object.values(call.matches as Record<string, boolean>).filter(Boolean).length : 0), 0),
      total_evaluated_answers: calls.reduce((sum, call) => sum + (call.matches ? Object.keys(call.matches as object).length : 0), 0),
    },
  };
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (serialized.includes(apiKey)) throw new Error('Refusing to write benchmark report containing the API key.');
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, serialized, { mode: 0o600 });
  if(report.status!=='complete')process.exitCode=1;
  process.stdout.write(`Saved 64k world-context benchmark: ${OUTPUT}\n`);
  process.stdout.write(`Calls: ${calls.length}; evaluated: ${report.summary.evaluated}; unevaluated: ${report.summary.unevaluated}; correct: ${report.summary.correct_answers}/${report.summary.total_evaluated_answers}\n`);
}

main().catch(error => {
  const status = errorStatus(error);
  process.stderr.write(status === 422 ? 'Benchmark stopped by provider context limit (HTTP 422). No response body was retained.\n' : 'World-context benchmark failed; details were suppressed to protect credentials and provider data.\n');
  process.exitCode = 1;
});
