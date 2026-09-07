import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Agent } from './agent/agent.js';
import { AgentBuilder } from './agent/agent-builder.js';
import type { AgentTemplate } from './agent/config.js';
import type { ModelProfile } from '../domain/model-profile.js';
import { resolveApiKeyForProfile } from '../domain/model-profile.js';
import { resolveModelProfileSync } from './services/resolve-model-profile.js';
import { resolveProjectDataDir } from '../infrastructure/persistence/paths.js';
import { ensureTemplatesSynced } from '../infrastructure/persistence/template-sync.js';

export type AgentFactory = () => Agent;

class TemplateRegistry {
  private templates: Map<string, AgentTemplate> = new Map();
  private metadata: Map<string, { order?: number }> = new Map();

  constructor() {
    this.loadFromConfigs();
  }

  private templatesDir(): string {
    return join(resolveProjectDataDir(), 'configs', 'templates');
  }

  private loadFromConfigs() {
    ensureTemplatesSynced();
    const configDir = this.templatesDir();
    if (!existsSync(configDir)) return;

    this.templates.clear();
    this.metadata.clear();

    const files = readdirSync(configDir).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      try {
        const path = join(configDir, file);
        const content = readFileSync(path, 'utf8');
        const config = JSON.parse(content) as AgentTemplate;
        const name = config.name || file.replace('.json', '');

        this.templates.set(name, config);
        this.metadata.set(name, { order: config.order });
      } catch (error) {
        console.error(`Failed to load template from ${file}:`, error);
      }
    }
  }

  buildAgent(name: string, modelProfile?: ModelProfile): Agent {
    const template = this.getConfig(name);
    if (!template) {
      throw new Error(
        `Template '${name}' not found. Available: ${this.list().map((t) => t.name).join(', ')}`
      );
    }

    const profile = modelProfile ?? resolveModelProfileSync();

    return new AgentBuilder()
      .ApiKey(resolveApiKeyForProfile(profile))
      .FromTemplate(template)
      .WithModelProfile(profile)
      .Build();
  }

  get(name: string, modelProfile?: ModelProfile): Agent {
    return this.buildAgent(name, modelProfile);
  }

  getConfig(name: string): AgentTemplate | null {
    this.loadFromConfigs();
    if (this.templates.has(name)) {
      return this.templates.get(name)!;
    }

    const path = join(this.templatesDir(), `${name}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as AgentTemplate;
  }

  saveConfig(name: string, config: AgentTemplate) {
    const configDir = this.templatesDir();
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    const path = join(configDir, `${name}.json`);
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
    this.loadFromConfigs();
  }

  list() {
    this.loadFromConfigs();
    return Array.from(this.templates.keys()).map((name) => ({
      name,
      order: this.metadata.get(name)?.order,
    }));
  }
}

export const templateRegistry = new TemplateRegistry();
