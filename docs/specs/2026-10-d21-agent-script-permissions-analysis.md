# D21 analysis: agent-saved scripts and Claude Code permissions

Moved from `docs/PLAN.md` section 2.5. The decision (option (b)) and its design are in the plan; this file holds the permission-system facts and the options considered.

## Analysis

**The user's position (2026-10-11):** agent-authored scripts should be governed by "whatever allow permission is set
to match normal Claude Code operations", i.e. Claude Code's own allow/ask/deny rules and permission modes, instead of
a separate approval in the Foundry UI.

**What Claude Code's permission system does for MCP tools (READ `code.claude.com/docs/en/permissions` and
`/docs/en/mcp`, fetched 2026-10-11):**

- Rules name a server or a tool: `mcp__wiretap`, `mcp__wiretap__*`, `mcp__wiretap__<tool>`; allow globs work only
  after a literal `mcp__<server>__` prefix (`mcp__github__get_*` matches its `get_` tools).
- Evaluation order is deny → ask → allow; a matching ask rule prompts even when an allow rule also matches.
- Settings-file rules cannot match MCP tool **arguments**: "it skips any `mcp__` rule that has parentheses". Argument
  matching for MCP tools exists only as a deny rule passed with `--disallowedTools`.
- Rules are enforced by Claude Code, not by the model; PreToolUse hooks can deny or force a prompt but do not
  override deny/ask rules.
- `dontAsk` auto-denies anything that would prompt but still runs tools pre-approved by allow rules;
  `bypassPermissions` skips prompts (except a listed set of actions).
- A server can set `_meta["anthropic/requiresUserInteraction"]: true` on a tool: Claude Code then prompts on every
  call "even in `acceptEdits`, `auto`, and `bypassPermissions`", offers no "don't ask again", allow rules do not skip
  it, `dontAsk` denies it, and an `allow` from `--permission-prompt-tool` is converted to a deny (v2.1.214+).
- Not stated in the permission table that was read: how long a "don't ask again" answer lasts for an MCP tool.

**What it cannot guarantee (INFERRED from the above and from D6):**

1. **Only calls that pass through that Claude Code instance are checked.** The MCP endpoint is unauthenticated on
   loopback (D6): any local process, another MCP client, or `claude -p --allowedTools mcp__wiretap` reaches
   `save_script` with no prompt at all. `_meta` annotations are Claude-Code-specific; other clients ignore them.
2. **The human sees what was saved only if a prompt appears.** In `bypassPermissions`/`auto`, or with a server-wide
   allow rule (`mcp__wiretap`), a save is not prompted. With a prompt, the code is visible in the call arguments.
3. **A saved script persists and becomes a new tool.** Later calls are governed by whatever rule matches the new
   tool's name in each later session, on each machine; a broad allow (`mcp__wiretap__*`) auto-approves every future
   saved script. Persistence outlives the session in which the human approved the save.
4. **Self-escalation.** A saved script runs with the endpoint user's authority (GM) and can call
   `game.settings.set` on Wiretap gates (the §4.6 known limit), create macros, or save further scripts.

**Options:**

| Option | What it is | Residual risk |
|---|---|---|
| (a) As the user states | `save_script` and saved-script tools governed only by Claude Code rules and modes | Items 1–4 in full: any local process or non-Claude client can save and run GM code; bypass/auto modes save without a human; saved code persists |
| (b) (a) + minimal Wiretap safeguards **(recommended)** | (1) world gate `allowAgentScripts`, GM-only, default OFF (consistent with D8); (2) `save_script` carries `_meta["anthropic/requiresUserInteraction"]: true`, so a human sees the code on every save in every Claude Code mode; (3) saved tools are named `agent__<name>` so a user can write `ask` rules for `mcp__wiretap__agent__*`; (4) code is hash-pinned at save and verified before each run; (5) disable instead of delete | With the gate ON: a non-Claude client or local process can still save code without a human (item 1); calls of saved scripts follow normal rules (item 3); item 4 remains. Cost: one gate, one annotation, a name prefix |
| (c) Foundry-UI approval (revision 2 design) | GM approves each proposal in a Wiretap window | Strongest for other clients, but contradicts the user's stated preference and adds a UI |

**Recommendation: (b).** It follows the user's model (Claude Code permissions decide), adds one human checkpoint that
Claude Code itself enforces even in bypass mode, and keeps the facility off unless a GM opts in. Decision is the
user's.
