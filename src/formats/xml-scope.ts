/** Chemical nodes inside a labelled atom belong to its child document, not the parent graph. */
export function scopeElements(root: Document | Element, tag: string): Element[] {
  return [...root.getElementsByTagName('*')].filter(el => {
    if (el.localName !== tag) return false;
    for (let parent = el.parentElement; parent && parent !== root; parent = parent.parentElement) if (parent.localName === 'n') return false;
    return true;
  });
}

export function fragmentXml(input: Document, fragment: Element): string {
  const root = input.documentElement.cloneNode(false) as Element;
  for (const child of input.documentElement.children) if (['fonttable', 'colortable'].includes(child.localName)) root.append(child.cloneNode(true));
  const page = input.createElementNS(root.namespaceURI, 'page'); page.append(fragment.cloneNode(true)); root.append(page);
  return new XMLSerializer().serializeToString(root);
}
