/**
 * Cursor CLI has no `--effort` flag. Effort is selected by catalog id
 * (`cursor-grok-4.6-xhigh`) or by parameterized `--model`
 * (`claude-opus-4-8[context=1m,effort=high,fast=false]`), as documented by
 * `cursor-agent --help` / `--list-models` on 2026.09.28-64d2043.
 *
 * Resolution uses the live `--list-models` catalog (injectable in tests). It
 * never invents capabilities, never changes model family/version, and never
 * downgrades an explicit requested effort to a lower listed one.
 */

import { spawnSync } from 'node:child_process';

import type { EffortLevel } from './types.js';

/** Effort tokens that appear in Cursor catalog ids, longest-first. */
const CATALOG_EFFORT_TOKEN =
  /^(.*?)-(extra-high|xhigh|minimal|medium|none|ultra|high|max|low)((?:-(?:fast|thinking))*)$/;

const PARAM_MODEL = /^(.*)\[([^\]]*)\]$/;

export interface CursorCommandInvocation {
  command: string;
  prefixArgs: string[];
}

export interface ParsedCursorModelId {
  /** Catalog id or parameterized base, with effort token removed and trailing fast/thinking kept. */
  family: string;
  effort?: string;
}

export interface ResolveCursorModelEffortInput {
  model?: string;
  effort?: EffortLevel;
  catalog: readonly string[];
}

let catalogOverride: readonly string[] | undefined;
const catalogCache = new Map<string, string[]>();

/** Test hook. Pass `undefined` to restore live listing. */
export function setCursorModelCatalogForTests(ids?: readonly string[]): void {
  catalogOverride = ids;
  catalogCache.clear();
}

export function parseCursorModelList(text: string): string[] {
  const ids: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^available models$/i.test(line)) continue;
    if (/^tip:/i.test(line)) continue;
    const sep = line.indexOf(' - ');
    if (sep <= 0) continue;
    ids.push(line.slice(0, sep).trim());
  }
  return ids;
}

export function parseCursorModelId(id: string): ParsedCursorModelId {
  const m = CATALOG_EFFORT_TOKEN.exec(id);
  if (!m) return { family: id };
  return { family: `${m[1]}${m[3]}`, effort: m[2] };
}

export function parseParameterizedCursorModel(model: string): {
  base: string;
  params: Record<string, string>;
  order: string[];
} | null {
  const m = PARAM_MODEL.exec(model.trim());
  if (!m) return null;
  const base = m[1];
  const params: Record<string, string> = {};
  const order: string[] = [];
  const body = m[2].trim();
  if (!body) return { base, params, order };
  for (const part of body.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid Cursor model parameter '${piece}' in '${model}'`);
    }
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (!order.includes(key)) order.push(key);
    params[key] = value;
  }
  return { base, params, order };
}

function formatParameterized(base: string, params: Record<string, string>, order: string[]): string {
  const keys = order.length > 0 ? order : Object.keys(params);
  return `${base}[${keys.map((k) => `${k}=${params[k]}`).join(',')}]`;
}

function catalogEffortNamesForRequest(effort: EffortLevel): string[] {
  if (effort === 'auto') return [];
  if (effort === 'xhigh') return ['xhigh', 'extra-high'];
  return [effort];
}

function familyEfforts(catalog: readonly string[], family: string): { id: string; effort?: string }[] {
  return catalog.map((id) => ({ id, ...parseCursorModelId(id) })).filter((row) => row.family === family);
}

function uniqueEfforts(rows: { effort?: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const e = row.effort;
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

function unsupportedEffortError(
  model: string,
  effort: string,
  family: string,
  rows: { id: string; effort?: string }[],
): Error {
  const listed = uniqueEfforts(rows);
  const listedIds = rows.map((r) => r.id).join(', ') || '(none)';
  const available = listed.length > 0 ? listed.join(', ') : 'none (id has no effort variants)';
  return new Error(
    `Unsupported Cursor effort '${effort}' for model '${model}'. ` +
      `Cursor has no --effort flag; effort is selected via --model catalog id or ` +
      `'base[effort=…]' parameterization. Family '${family}' listed efforts: ${available}. ` +
      `Catalog ids: ${listedIds}. Refusing to change model family/version or downgrade effort.`,
  );
}

/**
 * Choose the `--model` value that delivers `effort` without switching family.
 * `auto` / omitted effort returns `model` unchanged (or undefined when unset).
 */
export function resolveCursorModelEffort(input: ResolveCursorModelEffortInput): string | undefined {
  const { model, catalog } = input;
  const effort = input.effort;
  if (!effort || effort === 'auto') return model;

  if (!model) {
    throw new Error(
      `Cursor has no --effort flag; cannot apply effort '${effort}' without a model. ` +
        `Pass an effort-qualified catalog id (e.g. cursor-grok-4.6-xhigh) or a parameterized ` +
        `id (e.g. claude-opus-4-8[effort=high]).`,
    );
  }

  const parameterized = parseParameterizedCursorModel(model);
  const baseId = parameterized?.base ?? model;
  const parsed = parseCursorModelId(baseId);
  const family = parsed.family;
  const rows = familyEfforts(catalog, family);
  const wanted = catalogEffortNamesForRequest(effort);
  const matches = rows.filter((row) => row.effort !== undefined && wanted.includes(row.effort));

  if (parameterized) {
    const baseListed = catalog.includes(baseId);
    const familyHasEffortSuffixes = rows.some((row) => row.effort !== undefined);
    if (familyHasEffortSuffixes) {
      if (matches.length === 0) {
        throw unsupportedEffortError(model, effort, family, rows);
      }
    } else if (!baseListed) {
      throw new Error(
        `Unsupported Cursor effort '${effort}' for parameterized model '${model}'. ` +
          `Base '${baseId}' is not in --list-models; refusing to guess parameterization support.`,
      );
    }
    const params = { ...parameterized.params, effort };
    const order = parameterized.order.includes('effort') ? parameterized.order : [...parameterized.order, 'effort'];
    return formatParameterized(parameterized.base, params, order);
  }

  if (matches.length === 0) {
    throw unsupportedEffortError(model, effort, family, rows);
  }

  const exact = matches.find((row) => row.effort === effort);
  const chosen = exact ?? matches[0];
  return chosen.id;
}

function catalogCacheKey(invocation: CursorCommandInvocation): string {
  return `${invocation.command}\0${invocation.prefixArgs.join('\0')}`;
}

/**
 * Load `--list-models` ids. Cached per invocation; tests inject via
 * `setCursorModelCatalogForTests` so a turn never spawns the CLI.
 */
export function loadCursorModelCatalog(invocation: CursorCommandInvocation): string[] {
  if (catalogOverride) return [...catalogOverride];
  const key = catalogCacheKey(invocation);
  const hit = catalogCache.get(key);
  if (hit) return hit;
  const result = spawnSync(invocation.command, [...invocation.prefixArgs, '--list-models'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: process.platform === 'win32',
  });
  if (result.error) {
    throw new Error(`cursor --list-models failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`cursor --list-models exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  const ids = parseCursorModelList(result.stdout || '');
  catalogCache.set(key, ids);
  return ids;
}
