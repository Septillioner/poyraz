import { zodToJsonSchema } from 'zod-to-json-schema';
import { ToolDefinition, getToolSchema } from './types.js';

export const TOOL_ALIASES: Record<string, string> = {};

export const TOOL_PRESETS = {
  filesystem: ['read_file', 'edit_file', 'list_dir', 'glob_file_search', 'delete_file'],
  shell: ['run_terminal_cmd'],
  search: ['grep'],
} as const;

export type ToolPresetName = keyof typeof TOOL_PRESETS;

export function toOpenAISchema(tool: ToolDefinition) {
  let schema: any;
  if (tool.parametersJsonSchema) {
    schema = tool.parametersJsonSchema;
  } else {
    schema = zodToJsonSchema(getToolSchema(tool) as any, { $refStrategy: 'none' }) as any;
    if (schema.$schema) delete schema.$schema;
    if (schema.definitions) delete schema.definitions;
  }
  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: schema,
    },
  };
}

/**
 * A tool registry. The module-level `toolRegistry` is the shared one (built-ins register
 * there as a side effect of importing `tools/index`). `createToolRegistry()` makes an
 * instance whose registrations never touch it: lookups fall back to `parent`, writes stay local.
 */
export class ToolRegistry {
  private definitions = new Map<string, ToolDefinition>();

  constructor(private readonly parent?: ToolRegistry) {}

  register(def: ToolDefinition) {
    this.definitions.set(def.name, def);
    return def;
  }

  registerMany(defs: ToolDefinition[]) {
    for (const def of defs) this.register(def);
  }

  unregister(name: string): boolean {
    return this.definitions.delete(name);
  }

  resolveAlias(name: string): string {
    return TOOL_ALIASES[name] ?? name;
  }

  get(name: string): ToolDefinition | undefined {
    const canonical = this.resolveAlias(name);
    return this.definitions.get(canonical) ?? this.parent?.get(canonical);
  }

  /** Own definitions plus the parent's; an own definition shadows the parent's of the same name. */
  list(): ToolDefinition[] {
    const merged = new Map<string, ToolDefinition>();
    for (const def of this.parent?.list() ?? []) merged.set(def.name, def);
    for (const def of this.definitions.values()) merged.set(def.name, def);
    return Array.from(merged.values());
  }

  listNames(): string[] {
    return this.list().map((d) => d.name);
  }

  getPresentation(name: string) {
    const def = this.get(name);
    return def?.presentation ?? { label: name, icon: 'Wrench' };
  }

  /**
   * Picks tools by preset and/or name. An empty selection (no presets, no names) selects
   * NO tools: nothing is implied. `exclude` only removes from what was selected.
   */
  resolveToolSet(options: {
    presets?: ToolPresetName[];
    include?: string[];
    exclude?: string[];
  }): Record<string, ToolDefinition> {
    const names = new Set<string>();

    for (const preset of options.presets ?? []) {
      const presetNames = TOOL_PRESETS[preset];
      if (presetNames) presetNames.forEach((n) => names.add(n));
    }

    for (const name of options.include ?? []) {
      names.add(this.resolveAlias(name));
    }

    for (const name of options.exclude ?? []) {
      names.delete(this.resolveAlias(name));
    }

    const result: Record<string, ToolDefinition> = {};
    for (const name of names) {
      const def = this.get(name);
      if (def) result[def.name] = def;
    }
    return result;
  }

  toOpenAISchemas(toolNames?: string[]) {
    const defs = toolNames
      ? toolNames.map((n) => this.get(n)).filter((d): d is ToolDefinition => !!d)
      : this.list();

    return defs.map((tool) => toOpenAISchema(tool));
  }

  toCatalogEntries() {
    return this.list().map((def) => ({
      name: def.name,
      description: def.description,
      presentation: def.presentation,
      meta: def.meta,
      presets: (Object.entries(TOOL_PRESETS) as [ToolPresetName, readonly string[]][])
        .filter(([, names]) => names.includes(def.name))
        .map(([preset]) => preset),
    }));
  }
}

export const toolRegistry = new ToolRegistry();

/** Creates an isolated registry (empty, or layered over `parent`, e.g. the shared one for built-ins). */
export function createToolRegistry(parent?: ToolRegistry): ToolRegistry {
  return new ToolRegistry(parent);
}

export function resolveCanonicalToolName(name: string): string {
  return toolRegistry.resolveAlias(name);
}
