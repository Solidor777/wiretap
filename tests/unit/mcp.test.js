// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { makeCreateActorHandler } from '../../server/mcp.ts';
import { OP_CREATE_ACTOR } from '$shared/protocol.js';

describe('makeCreateActorHandler', () => {
   it('returns success content containing the new actor uuid', async () => {
      const bridge = { invokeOnGM: async () => ({ uuid: 'Actor.abc', id: 'abc', name: 'Bob', type: 'npc' }) };
      const handler = makeCreateActorHandler(bridge);
      const result = await handler({ name: 'Bob', type: 'npc' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Actor.abc');
      expect(result.content[0].text).toContain('Bob');
   });

   it('forwards name and type to the bridge as createActor params', async () => {
      let captured;
      const bridge = { invokeOnGM: async (op, params) => { captured = { op, params }; return { uuid: 'Actor.x', name: 'Z', type: 'character' }; } };
      const handler = makeCreateActorHandler(bridge);
      await handler({ name: 'Z' });
      expect(captured.op).toBe(OP_CREATE_ACTOR);
      expect(captured.params).toEqual({ name: 'Z', type: undefined });
   });

   it('forwards an explicit type to the bridge', async () => {
      let captured;
      const bridge = { invokeOnGM: async (op, params) => { captured = params; return { uuid: 'Actor.y', name: 'Z', type: 'character' }; } };
      const handler = makeCreateActorHandler(bridge);
      await handler({ name: 'Z', type: 'character' });
      expect(captured).toEqual({ name: 'Z', type: 'character' });
   });

   it('maps a bridge rejection to an isError tool result', async () => {
      const bridge = { invokeOnGM: async () => { throw new Error('No Foundry GM client connected'); } };
      const handler = makeCreateActorHandler(bridge);
      const result = await handler({ name: 'Bob' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No Foundry GM');
   });
});
