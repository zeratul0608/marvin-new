import {
  EDITOR_API_VERSION,
  type EditorApi,
  type EditorEvents,
  type EditorPlugin,
  type PluginCommand,
  type PluginCommandInfo,
  type PluginContext,
  type PluginInfo,
  type PluginPanel,
} from './api-types';

interface PluginHost {
  api: EditorApi;
  mountPanel(pluginId: string, panel: PluginPanel): () => void;
  on<K extends keyof EditorEvents>(type: K, listener: (detail: EditorEvents[K]) => void): () => void;
  notify(message: string): void;
  changed(): void;
  error(pluginId: string, error: unknown): void;
}
interface Activation { active: boolean; cleanups: Set<() => void>; panels: Set<string> }
interface InstalledPlugin { plugin: EditorPlugin; enabled: boolean; activation?: Activation }
interface RegisteredCommand {
  command: PluginCommand;
  entry: InstalledPlugin;
  activation: Activation;
  running: boolean;
}

/** A lifecycle boundary for trusted plugins. This is not a JavaScript sandbox. */
export class PluginRegistry {
  private readonly installed = new Map<string, InstalledPlugin>();
  private readonly registered = new Map<string, RegisteredCommand>();
  private destroyed = false;

  constructor(private readonly host: PluginHost) {}

  install(plugin: EditorPlugin, enabled = true): () => void {
    this.assertAlive();
    this.assertId(plugin.id, 'Plugin');
    if (this.installed.has(plugin.id)) throw new Error(`Plugin already installed: ${plugin.id}`);
    if (plugin.apiVersion !== EDITOR_API_VERSION) throw new Error(`Unsupported plugin API version: ${plugin.apiVersion}`);
    if (!plugin.name?.trim() || !plugin.version?.trim() || typeof plugin.activate !== 'function') {
      throw new Error('Plugins require a name, version and activate function.');
    }
    // Copy metadata so mutation of the original descriptor cannot change registry keys.
    const entry: InstalledPlugin = { plugin: { ...plugin }, enabled: false };
    this.installed.set(plugin.id, entry);
    try {
      if (enabled) this.activate(entry);
    } catch (error) {
      this.installed.delete(entry.plugin.id);
      this.host.changed();
      throw error;
    }
    this.host.changed();
    return () => {
      if (this.installed.get(entry.plugin.id) === entry) this.remove(entry.plugin.id);
    };
  }

  remove(id: string): void {
    const entry = this.installed.get(id);
    if (!entry) return;
    this.deactivate(entry);
    this.installed.delete(id);
    this.host.changed();
  }

  setEnabled(id: string, enabled: boolean): void {
    this.assertAlive();
    const entry = this.installed.get(id);
    if (!entry) throw new Error(`Unknown plugin: ${id}`);
    if (entry.enabled === enabled) return;
    if (enabled) this.activate(entry);
    else this.deactivate(entry);
    this.host.changed();
  }

  list(): PluginInfo[] {
    return [...this.installed.values()].map(({ plugin, enabled }) => ({
      id: plugin.id, name: plugin.name, version: plugin.version, description: plugin.description, enabled,
    }));
  }

  commands(): PluginCommandInfo[] {
    return [...this.registered].map(([id, { command, entry, running }]) => ({
      id, pluginId: entry.plugin.id, title: command.title, description: command.description, running,
    }));
  }

  async runCommand(id: string, input?: unknown): Promise<unknown> {
    this.assertAlive();
    const registered = this.registered.get(id);
    if (!registered) throw new Error(`Unknown plugin command: ${id}`);
    this.assertActive(registered.entry, registered.activation);
    if (registered.running) throw new Error(`Plugin command is already running: ${id}`);
    registered.running = true;
    this.host.changed();
    try {
      return await registered.command.execute(input);
    } catch (error) {
      this.report(registered.entry.plugin.id, error);
      throw error;
    } finally {
      registered.running = false;
      this.host.changed();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const entry of [...this.installed.values()].reverse()) this.deactivate(entry);
    this.installed.clear();
    this.registered.clear();
    this.host.changed();
  }

  private activate(entry: InstalledPlugin): void {
    const activation: Activation = { active: true, cleanups: new Set(), panels: new Set() };
    entry.activation = activation;
    entry.enabled = true;
    const guard = () => this.assertActive(entry, activation);
    // Guard both lookup and invocation, including functions retained by an async command.
    const editor = new Proxy({} as EditorApi, {
      get: (_target, property) => {
        guard();
        const value: unknown = Reflect.get(this.host.api, property);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { guard(); return Reflect.apply(value, this.host.api, args); };
      },
      set: () => { throw new Error('The plugin editor API is read-only.'); },
      defineProperty: () => { throw new Error('The plugin editor API is read-only.'); },
      deleteProperty: () => { throw new Error('The plugin editor API is read-only.'); },
    });
    const context: PluginContext = {
      apiVersion: EDITOR_API_VERSION,
      editor,
      registerCommand: command => {
        guard();
        this.assertId(command.id, 'Command');
        if (!command.title?.trim() || typeof command.execute !== 'function') throw new Error('Commands require a title and execute function.');
        const id = `${entry.plugin.id}.${command.id}`;
        if (this.registered.has(id)) throw new Error(`Plugin command already registered: ${id}`);
        const registered: RegisteredCommand = { command: { ...command }, entry, activation, running: false };
        this.registered.set(id, registered);
        const dispose = this.track(entry, activation, () => {
          if (this.registered.get(id) === registered) this.registered.delete(id);
          this.host.changed();
        });
        this.host.changed();
        return dispose;
      },
      addPanel: panel => {
        guard();
        this.assertId(panel.id, 'Panel');
        if (!panel.title?.trim() || typeof panel.mount !== 'function') throw new Error('Panels require a title and mount function.');
        if (activation.panels.has(panel.id)) throw new Error(`Plugin panel already registered: ${panel.id}`);
        activation.panels.add(panel.id);
        let dispose: () => void;
        try { dispose = this.host.mountPanel(entry.plugin.id, { ...panel }); }
        catch (error) { activation.panels.delete(panel.id); throw error; }
        return this.track(entry, activation, () => {
          activation.panels.delete(panel.id);
          dispose();
        });
      },
      on: (type, listener) => {
        guard();
        const unsubscribe = this.host.on(type, detail => {
          if (!activation.active) return;
          try { listener(detail); } catch (error) { this.report(entry.plugin.id, error); }
        });
        return this.track(entry, activation, unsubscribe);
      },
      notify: message => { guard(); this.host.notify(message); },
    };
    try {
      const cleanup: unknown = entry.plugin.activate(context);
      if (typeof cleanup === 'function') this.track(entry, activation, cleanup as () => void);
      else if (cleanup !== undefined) {
        // Consume accidental async activations so their rejected Promise is not unhandled.
        void Promise.resolve(cleanup).catch(() => undefined);
        throw new Error('Plugin activate must return synchronously with void or a cleanup function.');
      }
    } catch (error) {
      this.deactivate(entry);
      this.report(entry.plugin.id, error);
      this.host.changed();
      throw error;
    }
  }

  private deactivate(entry: InstalledPlugin): void {
    const activation = entry.activation;
    entry.enabled = false;
    entry.activation = undefined;
    if (!activation) return;
    activation.active = false;
    // User cleanup runs first, then resources are disposed in reverse registration order.
    for (const cleanup of [...activation.cleanups].reverse()) cleanup();
    activation.cleanups.clear();
  }

  private track(entry: InstalledPlugin, activation: Activation, cleanup: () => void): () => void {
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      activation.cleanups.delete(dispose);
      try {
        const result: unknown = cleanup();
        // TypeScript allows an async function where () => void is expected.
        if (result !== undefined) void Promise.resolve(result).catch(error => this.report(entry.plugin.id, error));
      } catch (error) { this.report(entry.plugin.id, error); }
    };
    // A host callback can synchronously disable a plugin while mounting a panel or
    // subscribing to an event. Resources created during that callback still need disposal.
    if (activation.active) activation.cleanups.add(dispose);
    else dispose();
    return dispose;
  }

  private report(pluginId: string, error: unknown): void {
    // Error reporting must not interrupt cleanup of the remaining plugin resources.
    try { this.host.error(pluginId, error); } catch { /* Host reporting is best-effort. */ }
  }

  private assertActive(entry: InstalledPlugin, activation: Activation): void {
    this.assertAlive();
    if (!activation.active || !entry.enabled || entry.activation !== activation || this.installed.get(entry.plugin.id) !== entry) {
      throw new Error(`Plugin context is inactive: ${entry.plugin.id}`);
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('Plugin registry has been destroyed.');
  }

  private assertId(id: string, kind: string): void {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`${kind} IDs must contain only letters, numbers, underscores and hyphens.`);
    }
  }
}
