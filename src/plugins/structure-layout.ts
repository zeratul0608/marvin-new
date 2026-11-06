import { layoutActions, type LayoutAction } from '../core/layout';
import type { EditorPlugin } from '../editor/api-types';

export const structureLayoutPlugin: EditorPlugin = {
  id: 'structure-layout', name: '结构排版', version: '1.0.0', apiVersion: 1,
  description: '片段横排、竖排、环形排列和等比例统一键长；保持图结构和片段内角度。',
  activate(context) {
    const execute = (action: LayoutAction) => {
      const snapshot = context.editor.getSnapshot();
      const result = context.editor.applyEdits({ expectedRevision: snapshot.revision, operations: [{ type: 'layout', atomIds: snapshot.selection.atomIds, action }] });
      context.editor.fit(); context.notify(`${layoutActions[action]}完成，可撤销`);
      return { revision: result.snapshot.revision };
    };
    const cleanups = Object.entries(layoutActions).map(([action, title]) => context.registerCommand({ id: action, title, execute: () => execute(action as LayoutAction) }));
    cleanups.push(context.addPanel({
      id: 'layout', title: '结构排版', mount(container) {
        const note = container.ownerDocument.createElement('p');
        note.textContent = '选中完整片段后操作；清空选区作用于全图。统一键长会将各片段等比例缩放至中位键长 1.5，不执行化学结构自动清理。';
        note.style.cssText = 'font-size:12px;line-height:1.7'; container.append(note);
        for (const [action, title] of Object.entries(layoutActions)) {
          const button = container.ownerDocument.createElement('button'); button.textContent = title;
          button.style.cssText = 'display:block;width:100%;margin:8px 0';
          button.addEventListener('click', () => { try { execute(action as LayoutAction); } catch (error) { context.notify((error as Error).message); } });
          container.append(button);
        }
        return () => container.replaceChildren();
      },
    }));
    return () => cleanups.reverse().forEach(cleanup => cleanup());
  },
};
