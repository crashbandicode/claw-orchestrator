/**
 * The only delegation marker that may supply a missing parent session id.
 * Handoff and tangent markers are a different relationship and are ignored.
 */
const DELEGATE_LINE = /^MEMENTO-DELEGATE-FROM:[ \t]*(\S+)[ \t]*$/;
const NON_DELEGATE_LINE = /^MEMENTO-(?:HANDOFF|TANGENT)-FROM:/;

export function parentSessionIdFromDelegateMarker(message: string): string | undefined {
  const first = message.split(/\r?\n/, 1)[0] ?? '';
  if (NON_DELEGATE_LINE.test(first)) return undefined;
  return DELEGATE_LINE.exec(first)?.[1];
}
