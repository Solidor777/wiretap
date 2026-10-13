// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { RESERVED_SCRIPT_NAMES } from '../../shared/scripts.js';
import { SHIPPED_SCRIPTS } from '../../src/bridge/scripts/index.js';
import { findToolMentions } from './contextBudgetHarness.js';

/** @type {string} The user-facing skill file shipped at the module root. */
const SKILL_FILE = path.join(import.meta.dirname, '..', '..', 'skills', 'wiretap', 'SKILL.md');

/** @type {string} The skill text. */
const text = fs.readFileSync(SKILL_FILE, 'utf8').replace(/\r\n/g, '\n');

describe('the user-facing wiretap skill', () => {
   it('has a name and a description in its frontmatter', () => {
      const match = /^---\nname: wiretap\ndescription: (.+)\n---\n/.exec(text);
      expect(match, 'frontmatter with name and description').not.toBeNull();
      expect(match[1].length).toBeGreaterThan(20);
   });

   it('stays short, since its body is paid for whenever it is loaded', () => {
      expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(60);
   });

   it('names every shipped script and every sidecar built-in as mcp__wiretap__<tool>', () => {
      const mentioned = findToolMentions(text);
      for (const name of [
         ...SHIPPED_SCRIPTS.map((entry) => entry.definition.name),
         ...RESERVED_SCRIPT_NAMES,
      ]) {
         expect(mentioned, name).toContain(name);
      }
   });

   it('names no tool that does not exist', () => {
      const known = new Set([
         ...SHIPPED_SCRIPTS.map((entry) => entry.definition.name),
         ...RESERVED_SCRIPT_NAMES,
      ]);
      for (const mention of findToolMentions(text)) {
         expect(known.has(mention), mention).toBe(true);
      }
   });
});
