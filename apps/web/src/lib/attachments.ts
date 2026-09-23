/**
 * What the user attached to a prompt, recovered from what was stored.
 *
 * Claude Code does not record attachments as a structured field. They arrive
 * two different ways, and each is recovered from a different place:
 *
 *   - Editor context and file mentions are *text*. They are already inside
 *     `turns.prompt_text`, and therefore already redacted. They are parsed
 *     here, in TypeScript, from the stored text — never re-read from
 *     `raw_events`, because that payload is raw and going back to it would
 *     route unredacted content to the page.
 *   - Screenshots and documents are base64 content blocks on the prompt
 *     record. They are not in `prompt_text` at all and are read from
 *     `raw_events` by `getPromptMedia()` in queries.ts.
 *
 * Every rule below was checked against the 466 turns in this archive on
 * 2026-09-22 (the queries are in the commit that added this file):
 *
 *   - 207 prompts carry an editor block: 154 `<ide_opened_file>`, 53
 *     `<ide_selection>`. No prompt carries both, no prompt carries two, and in
 *     all 207 the block leads the prompt — so this splits rather than searches.
 *   - All 53 selections match "The user selected the lines N to M from <path>:"
 *     and end with the constant "This may or may not be related…" trailer.
 *   - 55 prompts carry `@path` mentions.
 */

export type PromptAttachment =
  | {
      kind: 'selection';
      path: string;
      fromLine: number;
      toLine: number;
      /** The selected text itself, verbatim. Can run to a whole method. */
      snippet: string;
    }
  | { kind: 'open_file'; path: string }
  | { kind: 'mention'; path: string };

/** The editor block is always leading and always closed — see the header. */
const IDE_BLOCK = /^<(ide_opened_file|ide_selection)>([\s\S]*?)<\/\1>/;

/**
 * Constant tail on both block kinds.
 *
 * The whitespace BEFORE it is deliberately not consumed: the selected text is
 * everything between the colon-newline and this sentence, and one prompt in
 * this archive (turn 8539) selected two blank lines. Eating the leading
 * whitespace there leaves nothing after the colon for SELECTED to anchor on,
 * and the whole block parses as neither kind.
 */
const TRAILER = /This may or may not be related to the current task\.\s*$/;

/**
 * Paths on this machine contain spaces ("/Volumes/Macintosh HD 1/…"), so both
 * captures run non-greedily to their own terminator rather than to whitespace.
 *
 * The path is not always a path: an unsaved editor buffer is reported by its
 * tab name ("Untitled-1"), which names no file on disk. It is shown as given
 * rather than dropped — what was sent is what was sent.
 */
const SELECTED = /^The user selected the lines (\d+) to (\d+) from ([\s\S]+?):\n([\s\S]*)$/;
const OPENED = /^The user opened the file ([\s\S]+?) in the IDE\./;

/** `@` followed by anything that is not whitespace or a backtick. */
const MENTION = /(?:^|\s)@([^\s`]+)/g;

/**
 * Does an `@token` name a file?
 *
 * A bare `@word` is not a mention — PHPDoc `@param`, `@return` and `@method`
 * appear in pasted code in this archive and are the only non-path `@` tokens
 * in it. Requiring a separator or an extension excludes all three. This is a
 * heuristic over free text, not a recorded fact: a path-shaped token inside a
 * pasted error message (one such here, `@loader_path/../…`) is still read as a
 * mention, which is why these render as "mentioned in the prompt" rather than
 * as something the editor attached.
 */
function looksLikePath(token: string): boolean {
  return token.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(token);
}

export interface ParsedPrompt {
  /** What the user actually typed, with the editor block removed. */
  body: string;
  attachments: PromptAttachment[];
}

export function parsePrompt(prompt: string | null | undefined): ParsedPrompt {
  if (!prompt) return { body: '', attachments: [] };

  const attachments: PromptAttachment[] = [];
  const block = IDE_BLOCK.exec(prompt);
  const body = (block ? prompt.slice(block[0].length) : prompt).trim();

  if (block) {
    const inner = block[2]!.replace(TRAILER, '');
    const selected = SELECTED.exec(inner);
    const opened = OPENED.exec(inner);
    if (selected) {
      attachments.push({
        kind: 'selection',
        path: selected[3]!,
        fromLine: Number(selected[1]),
        toLine: Number(selected[2]),
        snippet: selected[4]!.replace(/\s+$/, ''),
      });
    } else if (opened) {
      attachments.push({ kind: 'open_file', path: opened[1]! });
    }
    // A block in neither phrasing is dropped rather than guessed at. It stays
    // visible in the raw prompt, which the Copy button still yields whole.
  }

  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION)) {
    // Trailing sentence punctuation belongs to the sentence, not the path.
    const path = match[1]!.replace(/[.,;:!?)\]]+$/, '');
    if (path === '' || seen.has(path) || !looksLikePath(path)) continue;
    seen.add(path);
    attachments.push({ kind: 'mention', path });
  }

  return { body, attachments };
}

/** The file a turn's editor block named, for the detail page's heading fallback. */
export function ideContextPath(attachments: PromptAttachment[]): string | null {
  const ide = attachments.find((a) => a.kind === 'selection' || a.kind === 'open_file');
  return ide ? ide.path : null;
}
