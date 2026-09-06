import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const editorPath = fileURLToPath(
  new URL('../src/features/editor/CodeMirrorNoteEditor.tsx', import.meta.url)
);

async function readEditorSource() {
  return readFile(editorPath, 'utf8');
}

test('Win+. keeps the native textarea target until the user returns to the editor', async () => {
  const source = await readEditorSource();

  // Regression: a short timeout reclaimed focus while the Windows picker was
  // still open, so only the first emoji could be selected.
  assert.doesNotMatch(source, /WIN_EMOJI_NO_BLUR_RESTORE_MS/);
  assert.doesNotMatch(source, /restorePreArmedBridge\(\);\s*\}\s*,\s*\d+/);

  // The next normal click in CodeMirror is the explicit hand-off point for a
  // completed picker session. That lets a later Win+. create a fresh target.
  assert.match(
    source,
    /focus:\s*\(\)\s*=>\s*\{[\s\S]*?emojiBridgeActiveRef\.current\s*=\s*false;/
  );
});

test('the opt-in compatibility bridge handles Windows shortcuts without generic blur focus-stealing', async () => {
  const source = await readEditorSource();

  // Some WebViews swallow Period, so the enabled bridge must be allowed to arm
  // on Meta. It must still be guarded by the persisted user setting.
  assert.match(
    source,
    /const isWindowsKey = event\.key === 'Meta'[\s\S]*?activateEmojiInputBridge\(\)/
  );
  assert.match(
    source,
    /const activateEmojiInputBridge[\s\S]*?if \(!isEmojiInputBridgeEnabled\(\)\) return false;/
  );
  assert.doesNotMatch(source, /bridge-activate-from-window-blur/);
  assert.match(
    source,
    /handleWindowBlur[\s\S]*?if \(!emojiBridgeActiveRef\.current\) return;/
  );
  assert.match(
    source,
    /event\.code === 'Space'[\s\S]*?restoreEditorFromEmojiBridge\(\);/
  );
});

test('focus events from the bridge itself cannot close the native picker session', async () => {
  const source = await readEditorSource();

  // Window capture receives element focus too. Only an actual window focus
  // return (after the system panel closes) may run the restore logic.
  assert.match(
    source,
    /const handleWindowFocus = \(event: FocusEvent\) => \{[\s\S]*?if \(event\.target !== window\) return;/
  );
});

test('native picker clicks are not treated as document pointer clicks', async () => {
  const source = await readEditorSource();

  // Regression: an underlying pointer event restored the editor after the
  // first emoji click and broke repeated selections.
  assert.doesNotMatch(source, /document\.addEventListener\('pointerdown', handleDocumentPointerDown, true\)/);
  assert.doesNotMatch(source, /document\.removeEventListener\('pointerdown', handleDocumentPointerDown, true\)/);
});

test('Backspace mirrors a bridge deletion instead of replaying its history', async () => {
  const source = await readEditorSource();

  // Regression: when the hidden Windows target became shorter after Backspace,
  // its remaining full value was inserted into CodeMirror as if it were new.
  assert.match(source, /lastEmojiBridgeInputType\.startsWith\('deleteContentBackward'\)/);
  assert.match(
    source,
    /committedEmojiBridgeText\.startsWith\(rawText\)[\s\S]*?rawText\.length < committedEmojiBridgeText\.length[\s\S]*?removedLength[\s\S]*?userEvent: 'delete\.backward'/
  );
  assert.match(source, /if \(deletedBridgeText \|\| isBackwardDelete\) \{[\s\S]*?restoreEditorFromEmojiBridge\(\);/);
  assert.match(source, /committedEmojiBridgeText = '';\s*lastEmojiBridgeInputType = '';\s*emojiBridgeSelectionRef/);
});

test('disabled Windows emoji support never suspends normal editor synchronization', async () => {
  const source = await readEditorSource();

  // Regression: the caller used to set suspendExternalSyncRef before the
  // opt-in bridge checked its setting, leaving normal editing suspended even
  // though the bridge did not activate.
  assert.match(source, /const activateEmojiInputBridge[\s\S]*?if \(!isEmojiInputBridgeEnabled\(\)\) return false;/);
  assert.match(
    source,
    /if \(activateEmojiInputBridge\(\)\) \{\s*suspendExternalSyncRef\.current = true;/
  );
});

test('Alt always releases the bridge and restores a lost editor caret', async () => {
  const source = await readEditorSource();

  // Regression: opening the native menu with Alt left the hidden bridge or the
  // document root focused, so typing continued without a visible CodeMirror caret.
  assert.match(source, /const restoreEditorAfterAlt = \(\) => \{[\s\S]*?restoreEditorFromEmojiBridge\(\);/);
  assert.match(source, /const isAltKey = event\.key === 'Alt'[\s\S]*?restoreEditorAfterAlt\(\);/);
  assert.match(source, /activeElement === document\.body[\s\S]*?activeElement === emojiBridge[\s\S]*?view\.focus\(\);/);
});

test('language switching restores the caret after Win+Space without blocking Windows', async () => {
  const source = await readEditorSource();

  // Regression: Win+Space changed the keyboard language, but when no emoji
  // bridge was active the editor stayed blurred and its caret disappeared.
  assert.match(source, /let languageSwitchPending = false;/);
  assert.match(
    source,
    /event\.metaKey && \(event\.code === 'Space' \|\| event\.key === ' '\)[\s\S]*?languageSwitchPending = true;[\s\S]*?return;/
  );
  assert.match(
    source,
    /languageSwitchPending && \(event\.code === 'Space' \|\| event\.key === ' '\)[\s\S]*?languageSwitchPending = false;[\s\S]*?restoreEditorAfterAlt\(\);/
  );
});
