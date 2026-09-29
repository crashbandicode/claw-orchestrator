import { afterEach, describe, expect, it } from 'vitest';
import {
  parseCursorModelId,
  parseCursorModelList,
  resolveCursorModelEffort,
  setCursorModelCatalogForTests,
} from '../cursor-model-effort.js';

const CATALOG = [
  'composer-2.5',
  'composer-2.5-fast',
  'cursor-grok-4.6-low',
  'cursor-grok-4.6-medium',
  'cursor-grok-4.6-high',
  'cursor-grok-4.6-xhigh',
  'claude-opus-5-5-low',
  'claude-opus-5-5-high',
  'claude-opus-5-5-xhigh',
  'claude-opus-5-5-xhigh-fast',
  'claude-opus-5-5-high-fast',
  'claude-opus-5-5-max',
  'claude-opus-5-thinking-high',
  'claude-opus-5-thinking-xhigh',
  'claude-4.6-sonnet-medium',
  'claude-4.6-sonnet-medium-thinking',
  'claude-opus-4-8-low',
  'claude-opus-4-8-high',
  'claude-opus-4-8-xhigh',
  'gpt-5.5-high',
  'gpt-5.5-extra-high',
  'gemini-3.8-flash-high',
];

afterEach(() => setCursorModelCatalogForTests(undefined));

describe('parseCursorModelList', () => {
  it('extracts ids from cursor-agent --list-models text', () => {
    const text = [
      'Available models',
      '',
      'composer-2.5 - Composer 2.5',
      'cursor-grok-4.6-xhigh - Grok 4.6 Extra High',
      '',
      "Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.",
    ].join('\n');
    expect(parseCursorModelList(text)).toEqual(['composer-2.5', 'cursor-grok-4.6-xhigh']);
  });
});

describe('parseCursorModelId', () => {
  it('keeps thinking-before-effort and fast-after-effort in the family', () => {
    expect(parseCursorModelId('claude-opus-5-thinking-high')).toEqual({
      family: 'claude-opus-5-thinking',
      effort: 'high',
    });
    expect(parseCursorModelId('claude-opus-5-5-xhigh-fast')).toEqual({
      family: 'claude-opus-5-5-fast',
      effort: 'xhigh',
    });
    expect(parseCursorModelId('claude-4.6-sonnet-medium-thinking')).toEqual({
      family: 'claude-4.6-sonnet-thinking',
      effort: 'medium',
    });
    expect(parseCursorModelId('composer-2.5-fast')).toEqual({ family: 'composer-2.5-fast' });
    expect(parseCursorModelId('gpt-5.5-extra-high')).toEqual({ family: 'gpt-5.5', effort: 'extra-high' });
  });
});

describe('resolveCursorModelEffort', () => {
  it('leaves the model unchanged when effort is auto or omitted', () => {
    expect(resolveCursorModelEffort({ model: 'grok-4.7', effort: 'auto', catalog: CATALOG })).toBe('grok-4.7');
    expect(resolveCursorModelEffort({ model: 'cursor-grok-4.6-high', catalog: CATALOG })).toBe('cursor-grok-4.6-high');
  });

  it('selects the same-family catalog id for an explicit effort', () => {
    expect(resolveCursorModelEffort({ model: 'cursor-grok-4.6-high', effort: 'xhigh', catalog: CATALOG })).toBe(
      'cursor-grok-4.6-xhigh',
    );
    expect(resolveCursorModelEffort({ model: 'cursor-grok-4.6', effort: 'low', catalog: CATALOG })).toBe(
      'cursor-grok-4.6-low',
    );
    expect(resolveCursorModelEffort({ model: 'claude-opus-5-5-xhigh', effort: 'max', catalog: CATALOG })).toBe(
      'claude-opus-5-5-max',
    );
  });

  it('preserves thinking and fast qualifiers and does not pick the other', () => {
    expect(resolveCursorModelEffort({ model: 'claude-opus-5-thinking-high', effort: 'xhigh', catalog: CATALOG })).toBe(
      'claude-opus-5-thinking-xhigh',
    );
    expect(resolveCursorModelEffort({ model: 'claude-opus-5-5-xhigh-fast', effort: 'high', catalog: CATALOG })).toBe(
      'claude-opus-5-5-high-fast',
    );
  });

  it('maps requested xhigh onto catalog extra-high when that is the listed extra-high id', () => {
    expect(resolveCursorModelEffort({ model: 'gpt-5.5-high', effort: 'xhigh', catalog: CATALOG })).toBe(
      'gpt-5.5-extra-high',
    );
  });

  it('rewrites parameterized effort without dropping other params', () => {
    expect(
      resolveCursorModelEffort({
        model: 'claude-opus-4-8[context=1m,effort=low,fast=false]',
        effort: 'high',
        catalog: CATALOG,
      }),
    ).toBe('claude-opus-4-8[context=1m,effort=high,fast=false]');
  });

  it('does not invent parameterization for a listed unsuffixed catalog id', () => {
    expect(() =>
      resolveCursorModelEffort({
        model: 'composer-2.5',
        effort: 'xhigh',
        catalog: ['composer-2.5'],
      }),
    ).toThrow(/no effort variants/);
  });

  it('rewrites an already-parameterized listed base even without effort-suffixed siblings', () => {
    expect(
      resolveCursorModelEffort({
        model: 'composer-2.5[effort=low]',
        effort: 'xhigh',
        catalog: ['composer-2.5'],
      }),
    ).toBe('composer-2.5[effort=xhigh]');
  });

  it('applies parameterized effort when the listed base has no effort-suffixed siblings', () => {
    expect(
      resolveCursorModelEffort({
        model: 'claude-opus-4-8[context=1m]',
        effort: 'high',
        catalog: ['claude-opus-4-8', 'composer-2.5'],
      }),
    ).toBe('claude-opus-4-8[context=1m,effort=high]');
  });

  it('still refuses a parameterized base that is not in the catalog', () => {
    expect(() =>
      resolveCursorModelEffort({
        model: 'not-a-real-model[effort=high]',
        effort: 'high',
        catalog: CATALOG,
      }),
    ).toThrow(/not-a-real-model/);
  });

  it('refuses grok-4.7 instead of substituting cursor-grok-4.6', () => {
    expect(() => resolveCursorModelEffort({ model: 'grok-4.7', effort: 'xhigh', catalog: CATALOG })).toThrow(
      /grok-4\.7[\s\S]*Refusing to change model family/,
    );
  });

  it('refuses composer effort instead of ignoring it or treating -fast as effort', () => {
    expect(() => resolveCursorModelEffort({ model: 'composer-2.5', effort: 'xhigh', catalog: CATALOG })).toThrow(
      /composer-2\.5[\s\S]*no effort variants/,
    );
  });

  it('refuses a higher effort than the family lists instead of downgrading', () => {
    expect(() => resolveCursorModelEffort({ model: 'cursor-grok-4.6-xhigh', effort: 'max', catalog: CATALOG })).toThrow(
      /max[\s\S]*low, medium, high, xhigh/,
    );
    expect(() =>
      resolveCursorModelEffort({ model: 'claude-4.6-sonnet-medium', effort: 'high', catalog: CATALOG }),
    ).toThrow(/high[\s\S]*medium/);
  });

  it('errors when effort is set without a model', () => {
    expect(() => resolveCursorModelEffort({ effort: 'high', catalog: CATALOG })).toThrow(/without a model/);
  });
});
