import { describe, expect, it, vi } from 'vitest';
import { PluginRegistry } from '../src/editor/plugins';
import { EDITOR_API_VERSION, type EditorApi, type EditorEvents, type EditorPlugin, type PluginContext } from '../src/editor/api-types';

function fixture() {
  const listeners = new Map<keyof EditorEvents, Set<(event: never) => void>>();
  const panels = new Set<string>();
  const getDocument = vi.fn(() => ({ title: 'current' }));
  const undo = vi.fn();
  const api = { getDocument, undo } as unknown as EditorApi;
  const host = {
    api,
    mountPanel: vi.fn((pluginId: string, panel: { id: string }) => {
      const id = `${pluginId}.${panel.id}`;
      panels.add(id);
      return () => { panels.delete(id); };
    }),
    on: <K extends keyof EditorEvents>(type: K, listener: (event: EditorEvents[K]) => void) => {
      const callbacks = listeners.get(type) ?? new Set();
      listeners.set(type, callbacks);
      callbacks.add(listener as (event: never) => void);
      return () => { callbacks.delete(listener as (event: never) => void); };
    },
    notify: vi.fn(), changed: vi.fn(), error: vi.fn(),
  };
  const registry = new PluginRegistry(host);
  return { registry, host, panels, listeners, getDocument, undo };
}

function plugin(id: string, activate: EditorPlugin['activate']): EditorPlugin {
  return { id, name: id, version: '1.0.0', apiVersion: EDITOR_API_VERSION, activate };
}

describe('trusted plugin lifecycle', () => {
  it('namespaces commands and panels and keeps editor registries isolated', async () => {
    const a = fixture(), b = fixture();
    const attach = (value: string) => (context: PluginContext) => {
      context.registerCommand({ id: 'inspect', title: 'Inspect', execute: () => value });
      context.addPanel({ id: 'summary', title: 'Summary', mount: () => undefined });
    };
    a.registry.install(plugin('first', attach('A')));
    a.registry.install(plugin('second', attach('B')));
    b.registry.install(plugin('first', attach('C')));
    expect(a.registry.commands().map(command => command.id)).toEqual(['first.inspect', 'second.inspect']);
    expect(a.panels).toEqual(new Set(['first.summary', 'second.summary']));
    expect(await a.registry.runCommand('first.inspect')).toBe('A');
    expect(await b.registry.runCommand('first.inspect')).toBe('C');
    a.registry.destroy();
    expect(a.registry.commands()).toEqual([]);
    expect(a.panels.size).toBe(0);
    expect(b.registry.list()).toHaveLength(1);
  });

  it('revokes old contexts and captured API functions permanently after disable and reenable', () => {
    const { registry, host, getDocument, undo } = fixture();
    const contexts: PluginContext[] = [];
    registry.install(plugin('example', context => { contexts.push(context); }));
    const old = contexts[0], oldUndo = old.editor.undo;
    expect(old.editor.getDocument()).toEqual({ title: 'current' });
    registry.setEnabled('example', false);
    registry.setEnabled('example', true);
    expect(() => old.editor.getDocument()).toThrow(/inactive/);
    expect(() => oldUndo()).toThrow(/inactive/);
    expect(() => old.notify('stale')).toThrow(/inactive/);
    expect(() => old.registerCommand({ id: 'stale', title: 'Stale', execute: () => undefined })).toThrow(/inactive/);
    contexts[1].editor.undo();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(host.notify).not.toHaveBeenCalled();
  });

  it('removes all resources even when a cleanup or error reporter throws', () => {
    const { registry, host, listeners, panels } = fixture();
    const callback = vi.fn(), laterCleanup = vi.fn();
    host.error.mockImplementation(() => { throw new Error('report failure'); });
    registry.install(plugin('example', context => {
      context.registerCommand({ id: 'inspect', title: 'Inspect', execute: () => undefined });
      context.addPanel({ id: 'summary', title: 'Summary', mount: () => undefined });
      context.on('change', callback);
      return () => { laterCleanup(); throw new Error('cleanup failure'); };
    }));
    registry.setEnabled('example', false);
    expect(laterCleanup).toHaveBeenCalledTimes(1);
    expect(host.error).toHaveBeenCalledWith('example', expect.objectContaining({ message: 'cleanup failure' }));
    expect(registry.commands()).toEqual([]);
    expect(panels.size).toBe(0);
    expect(listeners.get('change')?.size).toBe(0);
    registry.remove('example');
    registry.destroy();
    expect(laterCleanup).toHaveBeenCalledTimes(1);
  });

  it('prevents command reentry, reports rejected work and resets running state', async () => {
    const { registry, host } = fixture();
    let rejectWork!: (reason: Error) => void;
    registry.install(plugin('example', context => {
      context.registerCommand({ id: 'async', title: 'Async', execute: () => new Promise((_resolve, reject) => { rejectWork = reject; }) });
      context.registerCommand({ id: 'sync', title: 'Sync', execute: () => { throw new Error('sync failure'); } });
    }));
    const pending = registry.runCommand('example.async');
    expect(registry.commands()[0].running).toBe(true);
    await expect(registry.runCommand('example.async')).rejects.toThrow(/already running/);
    rejectWork(new Error('async failure'));
    await expect(pending).rejects.toThrow('async failure');
    expect(registry.commands()[0].running).toBe(false);
    await expect(registry.runCommand('example.sync')).rejects.toThrow('sync failure');
    expect(registry.commands()[1].running).toBe(false);
    expect(host.error).toHaveBeenCalledTimes(2);
  });

  it('rolls back failed activation and rejects duplicate registrations and async activation', async () => {
    const { registry, host, panels, listeners } = fixture();
    let stale!: PluginContext;
    expect(() => registry.install(plugin('broken', context => {
      stale = context;
      context.registerCommand({ id: 'inspect', title: 'Inspect', execute: () => undefined });
      context.addPanel({ id: 'summary', title: 'Summary', mount: () => undefined });
      context.on('change', () => undefined);
      context.registerCommand({ id: 'inspect', title: 'Duplicate', execute: () => undefined });
    }))).toThrow(/already registered/);
    expect(registry.list()).toEqual([]);
    expect(registry.commands()).toEqual([]);
    expect(panels.size).toBe(0);
    expect(listeners.get('change')?.size).toBe(0);
    expect(() => stale.editor.undo()).toThrow(/inactive/);
    const asyncPlugin = plugin('async', (() => Promise.reject(new Error('async activation'))) as unknown as EditorPlugin['activate']);
    expect(() => registry.install(asyncPlugin)).toThrow(/synchronously/);
    await Promise.resolve();
    expect(host.error).toHaveBeenCalledTimes(2);
  });

  it('does not let an old install disposer remove a later installation of the same ID', () => {
    const { registry } = fixture();
    const dispose = registry.install(plugin('example', () => undefined), false);
    registry.remove('example');
    registry.install(plugin('example', () => undefined));
    dispose();
    expect(registry.list()).toHaveLength(1);
    registry.destroy();
    expect(() => registry.install(plugin('another', () => undefined))).toThrow(/destroyed/);
  });

  it('reports an async cleanup rejection without interrupting resource disposal', async () => {
    const { registry, host } = fixture();
    registry.install(plugin('example', context => {
      context.registerCommand({ id: 'inspect', title: 'Inspect', execute: () => undefined });
      return async () => { throw new Error('async cleanup failure'); };
    }));
    registry.remove('example');
    expect(registry.commands()).toEqual([]);
    await Promise.resolve();
    expect(host.error).toHaveBeenCalledWith('example', expect.objectContaining({ message: 'async cleanup failure' }));
  });
});
