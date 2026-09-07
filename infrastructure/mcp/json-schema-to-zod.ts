import { z } from 'zod';

type JsonSchema = Record<string, any>;

function jsonSchemaTypeToZod(schema: JsonSchema): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.unknown();
  switch (schema.type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(schema.items ? jsonSchemaTypeToZod(schema.items) : z.unknown());
    case 'object':
      return jsonSchemaObjectToZod(schema);
    default:
      return z.unknown();
  }
}

function jsonSchemaObjectToZod(schema: JsonSchema): z.ZodObject<any> {
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, propSchema] of Object.entries(properties)) {
    const zodType = jsonSchemaTypeToZod(propSchema as JsonSchema);
    shape[key] = required.has(key) ? zodType : zodType.optional();
  }

  return z.object(shape).passthrough();
}

/**
 * Best-effort conversion from an MCP tool's JSON Schema `inputSchema` to Zod, used only for
 * local argument validation before dispatching to the MCP server. Falls back to an
 * open passthrough object so unknown/complex schemas never block execution.
 */
export function jsonSchemaToLooseZod(schema: unknown): z.ZodObject<any> {
  if (schema && typeof schema === 'object' && (schema as JsonSchema).type === 'object') {
    try {
      return jsonSchemaObjectToZod(schema as JsonSchema);
    } catch {
      return z.object({}).passthrough();
    }
  }
  return z.object({}).passthrough();
}
