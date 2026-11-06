import type { AiEditProposal } from './proposal';

export interface AiReviewPanel {
  element: HTMLElement;
  decision: Promise<boolean>;
  refresh(): void;
  markResult(ok: boolean, message?: string): void;
  cancel(): void;
}

/** Local UI only: diagrams are loaded as images, and all model/user text uses textContent. */
export function mountAiReviewPanel(container: HTMLElement, proposal: AiEditProposal, options: { getRevision: () => number; signal?: AbortSignal }): AiReviewPanel {
  const doc = container.ownerDocument;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
  };
  const expectedRevision = proposal.expectedRevision;
  const card = make('section', undefined, 'ai-edit-preview'); card.dataset.aiProposal = proposal.id; card.dataset.reviewState = 'pending';
  card.setAttribute('aria-label','AI 修改预览');
  card.append(make('strong',proposal.title));
  const figures = make('div',undefined,'ai-preview-figures');
  for (const [name, svg] of [['修改前',proposal.svg.before],['修改后',proposal.svg.after]]) {
    const figure = make('figure'), img = make('img'); img.alt = name;
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    figure.append(img,make('figcaption',name)); figures.append(figure);
  }
  card.append(figures);
  const totals = make('div',undefined,'ai-preview-totals');
  for (const [key,label] of [['atoms','画布节点'],['bonds','化学键'],['drawings','文档对象'],['reactions','反应步骤']] as const) {
    const count = proposal.totals[key], row = make('div');
    row.append(make('span',label),make('b',`${count.before} → ${count.after}`),make('small',`+${count.added} / −${count.removed} / Δ${count.updated}`)); totals.append(row);
  }
  card.append(totals);
  const changes = make('details',undefined,'ai-preview-changes');
  changes.append(make('summary','查看修改明细'));
  const list = make('ol');
  const kinds = {atom:'原子',bond:'化学键',drawing:'文档对象',reaction:'反应步骤',document:'文档'};
  const actions = {add:'新增',remove:'删除',update:'修改'};
  for (const change of proposal.changes) {
    const row = make('li'), name = make('span');
    const parts = change.label.split(' · ');
    if(parts.length>1){const raw=make('span',parts.slice(1).join(' · '));raw.dataset.i18nSkip='';name.append(make('span',parts[0]+' · '),raw);}else name.textContent=change.label;
    row.append(make('b',actions[change.action]), make('span',kinds[change.kind]), name);
    if (change.fields.length) { const fields = make('code',change.fields.join(', ')); row.append(fields); }
    if (change.details.length) { const raw = make('pre',change.details.join('\n')); raw.dataset.i18nSkip=''; row.append(raw); }
    list.append(row);
  }
  changes.append(list);
  if (proposal.truncated) changes.append(make('small','仅显示前 50 项明细，应用时仍执行完整批次。'));
  card.append(changes);
  for(const note of proposal.notes)card.append(make('small',note,'ai-note'));
  const status = make('p','等待应用此批修改；当前画布尚未改变。','ai-preview-status'); status.setAttribute('role','status');
  const buttons = make('div',undefined,'ai-actions');
  const approve = make('button','应用此批修改','ai-primary'); approve.type='button'; approve.dataset.aiAction='approve-edit';
  const decline = make('button','不应用'); decline.type='button'; decline.dataset.aiAction='reject-edit';
  buttons.append(approve,decline); card.append(status,buttons); container.append(card);
  let resolve!: (accepted:boolean)=>void, settled=false;
  const decision = new Promise<boolean>(done=>{resolve=done;});
  const finish = (accepted:boolean, state:string, text:string) => {
    if (settled) return; settled=true; card.dataset.reviewState=state; approve.disabled=true; decline.disabled=true; status.textContent=text;
    options.signal?.removeEventListener('abort',cancel); resolve(accepted);
  };
  const cancel = () => finish(false,'cancelled','已取消，未应用此批修改。');
  const refresh = () => {
    if (settled) return;
    const stale = options.getRevision() !== expectedRevision;
    approve.disabled=stale;
    status.textContent = stale ? '画布已变化，请不应用此批修改并重新生成预览。' : '等待应用此批修改；当前画布尚未改变。';
  };
  approve.addEventListener('click',()=>{
    refresh(); if (approve.disabled) return;
    finish(true,'approved','已确认，正在应用此批修改…');
  });
  decline.addEventListener('click',()=>finish(false,'rejected','此批修改未应用。'));
  options.signal?.addEventListener('abort',cancel,{once:true});
  if (options.signal?.aborted) cancel(); else refresh();
  return {element:card,decision,refresh,cancel,markResult(ok,message){
    if (card.dataset.reviewState!=='approved') return;
    card.dataset.reviewState=ok?'applied':'failed';
    status.textContent=ok?'修改已应用，可在编辑器中撤销。':`修改未应用：${message??'工具执行失败'}`;
  }};
}
