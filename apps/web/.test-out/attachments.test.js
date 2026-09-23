"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const attachments_js_1 = require("./attachments.js");
/**
 * Regression cases for the prompt-attachment parser.
 *
 * Every fixture below is a real prompt from this machine, copied verbatim from
 * `turns.prompt_text` — not invented. Run over all 466 stored prompts on
 * 2026-09-22 this parser recovers all 207 editor blocks (53 selections, 154
 * open files) and 63 `@path` mentions, with no block left unrecognised and no
 * block left behind in the body.
 */
const TRAILER = 'This may or may not be related to the current task.';
(0, node_test_1.test)('an editor selection yields its path, line range and text', () => {
    const { body, attachments } = (0, attachments_js_1.parsePrompt)(`<ide_selection>The user selected the lines 37 to 37 from /Volumes/Macintosh HD 1/Projects/Atom/telenor-associate/src/Platform/V1/Controllers/Associates/OTPTrait.php:\nsendOTPTrait\n\n${TRAILER}</ide_selection>\nNo, use associate_otp_references instead.`);
    strict_1.default.deepEqual(attachments, [
        {
            kind: 'selection',
            path: '/Volumes/Macintosh HD 1/Projects/Atom/telenor-associate/src/Platform/V1/Controllers/Associates/OTPTrait.php',
            fromLine: 37,
            toLine: 37,
            snippet: 'sendOTPTrait',
        },
    ]);
    strict_1.default.equal(body, 'No, use associate_otp_references instead.');
});
/**
 * Turn 8539: the user selected two blank lines. The block still names a file
 * and a line range, and dropping it because the selected text is empty would
 * lose both. This is why the trailer regex does not eat the whitespace before
 * itself — doing so left nothing for the pattern to anchor on and the whole
 * block parsed as neither kind.
 */
(0, node_test_1.test)('a selection of blank lines is still a selection', () => {
    const { attachments } = (0, attachments_js_1.parsePrompt)(`<ide_selection>The user selected the lines 157 to 158 from /Volumes/Macintosh HD 1/Projects/Atom/Atom-Store/public_html/mytmapi/src/Platform/V5/Controllers/OtpGiftController.php:\n\n\n\n${TRAILER}</ide_selection>\nRemove test mode otp send option.`);
    strict_1.default.equal(attachments.length, 1);
    strict_1.default.equal(attachments[0].kind, 'selection');
    strict_1.default.equal(attachments[0].snippet, '');
});
(0, node_test_1.test)('an opened file is reported as sent by the editor, not chosen', () => {
    const { body, attachments } = (0, attachments_js_1.parsePrompt)(`<ide_opened_file>The user opened the file /Volumes/Macintosh HD 1/Practice/ai-usages/apps/collector/src/server.ts in the IDE. ${TRAILER}</ide_opened_file>\nWhat does this do?`);
    strict_1.default.deepEqual(attachments, [
        {
            kind: 'open_file',
            path: '/Volumes/Macintosh HD 1/Practice/ai-usages/apps/collector/src/server.ts',
        },
    ]);
    strict_1.default.equal(body, 'What does this do?');
});
/** An unsaved buffer is named by its tab, not by a path. Shown as given. */
(0, node_test_1.test)('an unsaved buffer is kept under the name the editor gave it', () => {
    const { attachments } = (0, attachments_js_1.parsePrompt)(`<ide_selection>The user selected the lines 10 to 12 from Untitled-1:\n/1777965009.my.3x.png\n\n${TRAILER}</ide_selection>\nrename these`);
    strict_1.default.equal(attachments[0].path, 'Untitled-1');
});
(0, node_test_1.test)('@mentions are recovered, deduplicated, and stripped of sentence punctuation', () => {
    const { attachments } = (0, attachments_js_1.parsePrompt)('Why old OtpModel used here @Atom-Store/public_html/mytmapi/src/Platform/V1/Controllers/OtpController.php in line 67? Also check @docs/local-setup.md, and @docs/local-setup.md again.');
    strict_1.default.deepEqual(attachments.map((a) => a.path), ['Atom-Store/public_html/mytmapi/src/Platform/V1/Controllers/OtpController.php', 'docs/local-setup.md']);
});
/**
 * PHPDoc tags are the only non-path `@` tokens in this archive, and they appear
 * in pasted code. A bare word is not a file.
 */
(0, node_test_1.test)('PHPDoc tags in pasted code are not mentions', () => {
    const { attachments } = (0, attachments_js_1.parsePrompt)('Fix this:\n/**\n * @param string $a\n * @return void\n * @method foo\n */');
    strict_1.default.deepEqual(attachments, []);
});
(0, node_test_1.test)('a prompt with no attachments is returned unchanged', () => {
    const { body, attachments } = (0, attachments_js_1.parsePrompt)('Create a new branch and switch to it');
    strict_1.default.equal(body, 'Create a new branch and switch to it');
    strict_1.default.deepEqual(attachments, []);
});
(0, node_test_1.test)('a turn with no prompt text recorded parses to nothing, not to a crash', () => {
    strict_1.default.deepEqual((0, attachments_js_1.parsePrompt)(null), { body: '', attachments: [] });
});
