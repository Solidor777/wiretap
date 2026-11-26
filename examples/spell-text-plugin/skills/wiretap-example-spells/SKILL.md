---
name: wiretap-example-spells
description: Use when the user gives spell text (pasted, from a book or a chat message) and wants it turned into a spell Item in the live Foundry VTT world through Wiretap.
---
# Spells from text

The tool is `mcp__wiretap__wiretap-example-spells__create_spell`. It creates one spell Item per call.

1. **Read the spell text.** Find the name, the level (0 for a cantrip), the school, the casting time, the range, the
   duration and the components (`V`, `S`, `M`). Keep the times and distances as the text writes them.
2. **Fill the arguments.** `name`, `itemType` and `text` are required. `itemType` is the game system's Item type for
   spells (often `spell`); if you are unsure, `mcp__wiretap__list_document_types` lists the Item types. `text` is the
   rules text. Leave out any field the text does not give; do not guess.
3. **Call the tool.** It previews the create with a dry run first and writes only if the preview passes, so a
   refusal means nothing was created. Fix what the error names and call again.

The answer is one `{ uuid, name, type }` row for the new Item. For several spells, call the tool once per spell.
