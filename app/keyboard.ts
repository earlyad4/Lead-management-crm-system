export function normalizedKeyboardKey(event: { key?: unknown } | null | undefined): string {
  return typeof event?.key === "string" ? event.key.toLowerCase() : "";
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input,textarea,select,[contenteditable='true'],[role='textbox']") || Boolean(target.closest("[contenteditable='true']"));
}
