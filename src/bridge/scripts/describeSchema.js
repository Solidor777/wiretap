/**
 * The shipped `describe_schema` script. The definition is in `definitions.js`; the description is
 * `ctx.core.describeSchema`.
 */

/**
 * Describe a document class and subtype, or a path inside its schema.
 * @param {import('~/bridge/scripts/schemaDescribe.js').DescribeParams} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @returns {Record<string, unknown>} The description, within `DESCRIBE_SCHEMA_MAX_BYTES`.
 */
export function describeSchemaHandler(args, ctx) {
   return ctx.core.describeSchema(args, ctx.log);
}
