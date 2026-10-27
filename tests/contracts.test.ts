import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { contracts, hash, startSchema } from '../src/rpg/contracts.js';

it('preserves the normalized Zod 3 start configuration and its persisted hash', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/zod3-start-config.json', import.meta.url), 'utf8'));
  const parsed = startSchema.parse(baseline.input);
  expect(parsed).toEqual(baseline.parsed);
  expect(hash(parsed)).toBe(baseline.hash);
});

it('fills all time costs when omitted, empty or partially overridden', () => {
  const input = { game_id: 'game', expected_revision: 0, idempotency_key: 'clock' };
  const defaults = { move: 60, attack: 6, use_item: 6, skill_check: 30, inspect: 0, choose: 0 };
  for (const extra of [{}, { action_seconds: {} }]) {
    expect(contracts.rpg_game_time_configure.parse({ ...input, ...extra }).action_seconds).toEqual(defaults);
  }
  expect(contracts.rpg_game_time_configure.parse({ ...input, action_seconds: { move: 90 } }).action_seconds)
    .toEqual({ ...defaults, move: 90 });
});

it('keeps nested record validation and strict time-cost validation', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/zod3-start-config.json', import.meta.url), 'utf8'));
  baseline.input.state.characters.hero.hp = '3';
  expect(startSchema.safeParse(baseline.input).success).toBe(false);
  const input = { game_id: 'game', expected_revision: 0, idempotency_key: 'clock' };
  for (const action_seconds of [{ move: -1 }, { move: 0.5 }, { unexpected: 1 }]) {
    expect(contracts.rpg_game_time_configure.safeParse({ ...input, action_seconds }).success).toBe(false);
  }
});
