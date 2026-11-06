import { translateEnglish } from './i18n-en';

export type EditorLocale = 'zh-CN' | 'en';

export function normalizeEditorLocale(value: unknown): EditorLocale {
  if (value === 'zh-CN' || value === 'en') return value;
  throw new RangeError('Unsupported editor locale: ' + String(value));
}

interface TranslationState {
  source: string;
  rendered: string;
}
interface ImplicitOptionState {
  source: string | null;
  rendered: string | null;
}
const uiAttributes = ['title', 'aria-label', 'placeholder', 'alt'] as const;
const excludedSelector = 'style, script, pre, code, [data-i18n-skip]';

/** Translates editor UI in place, preserving DOM identity, form values and source strings. */
export class EditorI18n {
  private currentLocale: EditorLocale;
  private textSources = new WeakMap<Text, TranslationState>();
  private attributeSources = new WeakMap<Element, Map<string, TranslationState>>();
  private implicitOptions = new WeakMap<HTMLOptionElement, ImplicitOptionState>();
  private observer: MutationObserver;
  private pending = false;
  private destroyed = false;

  constructor(private readonly root: ShadowRoot | HTMLElement, locale: EditorLocale = 'zh-CN') {
    this.currentLocale = normalizeEditorLocale(locale);
    const Observer = root.ownerDocument.defaultView?.MutationObserver ?? MutationObserver;
    this.observer = new Observer(records => {
      if (this.destroyed || this.pending || !records.some(record => this.externalChange(record))) return;
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        if (!this.destroyed) this.translate();
      });
    });
    this.translate();
    this.observer.observe(root, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: [...uiAttributes, 'label', 'data-i18n-skip', 'contenteditable'],
    });
  }

  get locale(): EditorLocale { return this.currentLocale; }

  setLocale(locale: EditorLocale): void {
    if (this.destroyed) return;
    this.currentLocale = normalizeEditorLocale(locale);
    this.translate();
  }

  /** Synchronous pass, also useful immediately after the host renders new UI. */
  translate(): void {
    if (this.destroyed) return;
    this.visit(this.root);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pending = false;
    this.observer.disconnect();
  }

  private translated(source: string): string {
    if (this.currentLocale === 'zh-CN') return source;
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(source)!;
    return match[2] ? match[1] + translateEnglish(match[2]) + match[3] : source;
  }

  private blocked(node: Node, includeSelf = true): boolean {
    const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    if (!element) return false;
    if (element.closest(excludedSelector) || (node.nodeType === Node.TEXT_NODE && element.closest('textarea'))) return true;
    const editable = element.closest('[contenteditable]');
    if (editable && editable.getAttribute('contenteditable')?.toLowerCase() !== 'false') return true;
    // An SVG element's own accessible name is UI; its descendants are chemical drawing data.
    const svg = element.closest('svg');
    return !!svg && (svg !== element || !includeSelf);
  }

  private visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!this.blocked(node, false)) this.translateText(node as Text);
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      if (this.blocked(element)) return;
      for (const attribute of uiAttributes) this.translateAttribute(element, attribute);
      if (element.localName === 'svg' || element.localName === 'textarea') return;
      if (element.localName === 'option') {
        const option = element as HTMLOptionElement;
        if (!option.hasAttribute('value')) {
          this.translateImplicitOption(option);
          return;
        }
        const implicit = this.implicitOptions.get(option);
        if (implicit) {
          if (option.getAttribute('label') === implicit.rendered) {
            if (implicit.source === null) option.removeAttribute('label');
            else option.setAttribute('label', implicit.source);
          }
          this.implicitOptions.delete(option);
        }
        this.translateAttribute(option, 'label');
      }
    }
    for (const child of node.childNodes) this.visit(child);
  }

  private translateText(node: Text): void {
    const current = node.data;
    let state = this.textSources.get(node);
    if (!state) {
      state = { source: current, rendered: current };
      this.textSources.set(node, state);
    } else if (current !== state.rendered) state.source = current;
    const rendered = this.translated(state.source);
    state.rendered = rendered;
    if (current !== rendered) node.data = rendered;
  }

  private translateAttribute(element: Element, name: string): void {
    const current = element.getAttribute(name);
    let states = this.attributeSources.get(element);
    if (current === null) { states?.delete(name); return; }
    if (!states) { states = new Map(); this.attributeSources.set(element, states); }
    let state = states.get(name);
    if (!state) { state = { source: current, rendered: current }; states.set(name, state); }
    else if (current !== state.rendered) state.source = current;
    const rendered = this.translated(state.source);
    state.rendered = rendered;
    if (current !== rendered) element.setAttribute(name, rendered);
  }

  private translateImplicitOption(option: HTMLOptionElement): void {
    // Without an explicit value, changing option text would silently change its form value.
    // A translated label gives the user English UI while retaining the original value/text.
    const current = option.getAttribute('label');
    let state = this.implicitOptions.get(option);
    if (!state) { state = { source: current, rendered: current }; this.implicitOptions.set(option, state); }
    else if (current !== state.rendered) state.source = current;
    const text = state.source ?? option.textContent ?? '';
    const translation = this.translated(text);
    const rendered = this.currentLocale === 'en' && translation !== text ? translation : state.source;
    state.rendered = rendered;
    if (current !== rendered) {
      if (rendered === null) option.removeAttribute('label');
      else option.setAttribute('label', rendered);
    }
  }

  private externalChange(record: MutationRecord): boolean {
    if (this.blocked(record.target, record.type !== 'characterData')) return false;
    if (record.type === 'childList') return record.addedNodes.length > 0;
    if (record.type === 'characterData') {
      const node = record.target as Text;
      return this.textSources.get(node)?.rendered !== node.data;
    }
    const element = record.target as Element, name = record.attributeName!;
    if (name === 'data-i18n-skip' || name === 'contenteditable') return true;
    if (name === 'label' && element.localName === 'option') {
      const state = this.implicitOptions.get(element as HTMLOptionElement);
      if (state) return state.rendered !== element.getAttribute(name);
    }
    if (![...uiAttributes, 'label'].includes(name as typeof uiAttributes[number])) return false;
    return this.attributeSources.get(element)?.get(name)?.rendered !== element.getAttribute(name);
  }
}
