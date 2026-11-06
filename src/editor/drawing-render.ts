import type { ChemicalDocument, DrawingObject } from '../core/types';
import { escapeXml as esc } from '../formats/shared';
import { geometryStride } from '../core/drawing';
import {getPolymerGroup} from '../core/polymers';

export function drawingPoints(object: DrawingObject): {x:number;y:number}[] {
  if (['page','group'].includes(object.tag)) return [];
  return Object.entries(object.geometry).flatMap(([key, values]) => Array.from({length: values.length / geometryStride[key]}, (_, i) => ({x:values[i * geometryStride[key]] / 20,y:values[i * geometryStride[key] + 1] / 20})));
}
export function drawingMarkup(doc: ChemicalDocument, selected?: string): string {
  const objects = doc.depiction.objects ?? {};
  const color = (value: string | undefined, fallback: string) => { const i = Number(value); const rgb = doc.depiction.style?.colors[i - 2]; return rgb ? `rgb(${rgb.map(n => Math.round(n * 255)).join(',')})` : i === 1 ? '#fff' : fallback; };
  return Object.values(objects).sort((a,b) => Number(a.attributes.Z ?? 0) - Number(b.attributes.Z ?? 0)).map(object => {
    const a = object.attributes, g = object.geometry;
    if (a.Visible === 'no' || a.Visible === '0' || object.references.SupersededBy?.some(ref => ref.kind === 'drawing' && objects[ref.id])) return '';
    const p = g.p ?? g.xyz, box = g.BoundingBox;
    const stroke = color(a.color, '#303a43'), fill = a.FillType === 'Solid' || /Filled|Solid/.test(a.RectangleType ?? a.OvalType ?? '') ? color(a.color, '#303a43') : 'none';
    const width = Math.max(.015, Number(a.LineWidth ?? doc.depiction.style?.attributes.LineWidth ?? 1) / 20);
    const dash = /Dash/.test(a.LineType ?? a.CurveType ?? '') ? ' stroke-dasharray=".18 .12"' : '';
    const head = (x: number, y: number, angle: number) => `<path d="M${x - .32*Math.cos(angle-.4)} ${y - .32*Math.sin(angle-.4)} L${x} ${y} L${x-.32*Math.cos(angle+.4)} ${y-.32*Math.sin(angle+.4)}" fill="none"/>`;
    let shape = '';
    if (object.tag === 't') {
      const anchor = p ?? box?.slice(0,2) ?? [0,0], x = anchor[0]/20, y = anchor[1]/20;
      let line = 0;
      shape = `<text x="${x}" y="${y}" stroke="none" fill="${stroke}">${(object.runs ?? []).map(run => {
        const attrs = run.attributes, face = Number(attrs.face ?? 0), size = Number(attrs.size ?? doc.depiction.style?.attributes.CaptionSize ?? 10)/20;
        const font = doc.depiction.style?.fonts.find(f => f.id === attrs.font)?.name ?? 'Arial';
        return run.text.split(/\r\n|\r|\n/).map((text,i) => `<tspan${i ? ` x="${x}" dy="${size*1.25}" data-line="${++line}"` : ''} font-family="${esc(font)}" font-size="${size}" font-weight="${face&1?'bold':'normal'}" font-style="${face&2?'italic':'normal'}"${face&4?' text-decoration="underline"':''}${face&0x60?` baseline-shift="${face&0x40?'super':'sub'}"`:''} fill="${color(attrs.color, stroke)}">${esc(text)}</tspan>`).join('');
      }).join('')}</text>`;
    } else if (object.tag === 'arrow' && g.Head3D && g.Tail3D) {
      const [x1,y1] = g.Tail3D.map(n=>n/20), [x2,y2] = g.Head3D.map(n=>n/20), angle = Math.atan2(y2-y1,x2-x1);
      shape = `<path d="M${x1} ${y1} L${x2} ${y2}" fill="none"/>`;
      if (a.ArrowheadHead !== 'None') shape += head(x2,y2,angle);
      if (a.ArrowheadTail && a.ArrowheadTail !== 'None') shape += head(x1,y1,angle+Math.PI);
    } else if (object.tag === 'curve' && g.CurvePoints?.length >= 8) {
      const points = g.CurvePoints.map(n=>n/20); let path = `M${points[2]} ${points[3]}`;
      for (let i=4; i+5<points.length; i+=6) path += ` C${points.slice(i,i+6).join(' ')}`;
      shape = `<path d="${path}${a.Closed==='yes'?' Z':''}"/>`;
    } else if (object.tag === 'graphic' && box) {
      const [x1,y1,x2,y2] = box.map(n=>n/20), type = a.GraphicType ?? 'Line';
      if(type==='Bracket'){
        const kind=a.BracketType??'RoundPair',pair=kind.endsWith('Pair'),top=Math.min(y1,y2),bottom=Math.max(y1,y2),left=Math.min(x1,x2),right=Math.max(x1,x2);
        const bracket=(sx:number,sy:number,ex:number,ey:number)=>{
          const dx=ex-sx,dy=ey-sy,length=Math.hypot(dx,dy)||1,nx=-dy/length*.22,ny=dx/length*.22;
          const point=(t:number,normal=0)=>`${sx+dx*t+nx*normal} ${sy+dy*t+ny*normal}`;
          if(kind.startsWith('Square'))return `M${point(0,1)} L${point(0)} L${point(1)} L${point(1,1)}`;
          if(kind.startsWith('Curly'))return `M${point(0,1)} Q${point(0)} ${point(.25)} Q${point(.5)} ${point(.5,-1)} Q${point(.5)} ${point(.75)} Q${point(1)} ${point(1,1)}`;
          return `M${point(0,1)} C${point(.2,-1)} ${point(.8,-1)} ${point(1,1)}`;
        };
        shape=`<path data-bracket-type="${esc(kind)}" d="${pair?bracket(left,bottom,left,top)+' '+bracket(right,top,right,bottom):bracket(x1,y1,x2,y2)}" fill="none"/>`;
      }else if (type === 'Rectangle') shape = `<rect x="${Math.min(x1,x2)}" y="${Math.min(y1,y2)}" width="${Math.abs(x2-x1)}" height="${Math.abs(y2-y1)}"/>`;
      else if (type === 'Oval') shape = `<ellipse cx="${x1}" cy="${y1}" rx="${Math.abs(x2-x1)||.25}" ry="${Math.abs(y2-y1)||Math.abs(x2-x1)}"/>`;
      else { shape = `<path d="M${x1} ${y1} L${x2} ${y2}" fill="none"/>`; if (a.ArrowType && a.ArrowType !== 'NoHead') shape += head(x2,y2,Math.atan2(y2-y1,x2-x1)); }
    } else if (object.tag === 'embeddedobject' && box) {
      const encoded = a.PNG ?? a.JPEG, mime = a.PNG ? 'image/png' : 'image/jpeg';
      if (encoded && /^[\da-f\s]+$/i.test(encoded) && encoded.replace(/\s/g,'').length % 2 === 0) {
        const hex = encoded.replace(/\s/g,''); let binary=''; for (let i=0;i<hex.length;i+=2) binary+=String.fromCharCode(parseInt(hex.slice(i,i+2),16));
        shape = `<image x="${Math.min(box[0],box[2])/20}" y="${Math.min(box[1],box[3])/20}" width="${Math.abs(box[2]-box[0])/20}" height="${Math.abs(box[3]-box[1])/20}" href="data:${mime};base64,${btoa(binary)}"/>`;
      }
    } else if (object.tag === 'plasmidmap' && p) {
      const radius = Number(a.RingRadius ?? 0)/65536/20; shape = `<circle cx="${p[0]/20}" cy="${p[1]/20}" r="${radius||2}" fill="none"/>`;
    } else if(object.tag==='bracketedgroup'){
      const group=getPolymerGroup(doc,object.id),text=group.usage==='MultipleGroup'?String(group.repeatCount??2):group.label??(group.usage==='SRU'?'n':'');
      const boxes=group.crossings.flatMap(c=>c.graphicId&&objects[c.graphicId]?.geometry.BoundingBox?[objects[c.graphicId].geometry.BoundingBox]:[]);
      const points=[...boxes.flatMap(v=>[{x:v[0]/20,y:v[1]/20},{x:v[2]/20,y:v[3]/20}]),...group.atomIds.map(id=>({x:doc.depiction.positions[id].x,y:-doc.depiction.positions[id].y}))];
      if(text&&points.length)shape=`<text data-polymer-label="${esc(object.id)}" x="${Math.max(...points.map(p=>p.x))+.16}" y="${Math.max(...points.map(p=>p.y))+.24}" font-family="Arial" font-size=".3" fill="${stroke}" stroke="white" stroke-width=".06" paint-order="stroke">${esc(text)}</text>`;
    } else if (box && !['page','group','chemicalproperty','annotation','objecttag','represent','bracketattachment','crossingbond'].includes(object.tag)) {
      // Preserve native parameters. This neutral outline identifies an editable
      // specialized drawing; it does not claim a faithful BioDraw rendering.
      shape = `<rect x="${Math.min(box[0],box[2])/20}" y="${Math.min(box[1],box[3])/20}" width="${Math.abs(box[2]-box[0])/20}" height="${Math.abs(box[3]-box[1])/20}" fill="none" stroke-dasharray=".12 .08"/><title>${esc(a.BioShapeType ?? object.tag)} · 参数图元</title>`;
    }
    if (!shape) return '';
    const selectedBox = selected === object.id && box ? `<rect x="${Math.min(box[0],box[2])/20-.1}" y="${Math.min(box[1],box[3])/20-.1}" width="${Math.abs(box[2]-box[0])/20+.2}" height="${Math.abs(box[3]-box[1])/20+.2}" fill="none" stroke="#178377" stroke-dasharray=".1 .1"/>` : '';
    return `<g data-drawing="${esc(object.id)}" stroke="${selected===object.id?'#178377':stroke}" stroke-width="${width}" fill="${fill}"${dash}>${shape}${selectedBox}</g>`;
  }).join('');
}
