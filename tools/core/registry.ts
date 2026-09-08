import { zodToJsonSchema } from 'zod-to-json-schema';
import { ToolDefinition, getToolSchema } from './types.js';

export const TOOL_ALIASES: Record<string, string> = {};

export const TOOL_PRESETS = {
  filesystem: ['read_file', 'edit_file', 'list_dir', 'glob_file_search', 'delete_file'],
  shell: ['run_terminal_cmd'],
  planning: ['todo_write'],
  search: ['grep'],
  delegation: ['delegate_task'],
} as const;

export type ToolPresetName = keyof typeof TOOL_PRESETS;

class ToolRegistryImpl {
  private definitions = new Map<string, ToolDefinition>();

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
    return this.definitions.get(this.resolveAlias(name));
  }

  list(): ToolDefinition[] {
    return Array.from(this.definitions.values());
  }

  listNames(): string[] {
    return this.list().map((d) => d.name);
  }

  getPresentation(name: string) {
    const def = this.get(name);
    return def?.presentation ?? { label: name, icon: 'Wrench' };
  }

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

    if (names.size === 0) {
      this.listNames().forEach((n) => names.add(n));
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

    return defs.map((tool) => {
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
    });
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

export const toolRegistry = new ToolRegistryImpl();

export function resolveCanonicalToolName(name: string): string {
  return toolRegistry.resolveAlias(name);
}
