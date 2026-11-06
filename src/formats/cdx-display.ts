import type { CdxObject } from './cdx';
import { escapeXml as esc, fail } from './shared';

const refuse = (reason: string): never => fail(`CDX 排版映射不完整：${reason}`, 'PRESERVATION_UNSUPPORTED');
const u16 = (data: Uint8Array, offset: number) => { if (offset + 2 > data.length) return refuse('数据截断'); return data[offset] | data[offset + 1] << 8; };

/** Strict mappings for documented tables and rich text; unsupported encodings never fall back silently. */
export function cdxDisplayMapper(root: CdxObject) {
  const charsets = new Map<number, number>();
  const scan = (o: CdxObject) => {
    const table = o.props.get(0x0100);
    if (table) readFonts(table);
    o.children.forEach(scan);
  };
  const readFonts = (data: Uint8Array): string => {
    if (data.length < 4) return refuse('字体表截断');
    const fonts: string[] = []; let offset = 4;
    const platform = u16(data, 0);
    if (![0, 1].includes(platform)) return refuse('字体平台无效');
    for (let i = 0; i < u16(data, 2); i++) {
      const id = u16(data, offset), charset = u16(data, offset + 2), length = u16(data, offset + 4); offset += 6;
      if (offset + length > data.length || data.subarray(offset, offset + length).some(v => v < 32 || v > 126)) return refuse('字体名称编码尚未映射');
      if (charsets.has(id) && charsets.get(id) !== charset) return refuse('不同作用域的字体编号重复');
      charsets.set(id, charset);
      fonts.push(`<font id="${id}" charset="${charset}" name="${esc(String.fromCharCode(...data.subarray(offset, offset + length)))}"/>`); offset += length;
    }
    if (offset !== data.length) return refuse('字体表尾部数据未解释');
    return `<fonttable>${fonts.join('')}</fonttable>`;
  };
  scan(root);
  const decode = (bytes: Uint8Array, font: number) => {
    const charset = charsets.get(font);
    const encodings: Record<number, string> = { 0: 'windows-1252', 1252: 'windows-1252', 65001: 'utf-8', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5' };
    if (charset === undefined || !encodings[charset]) return refuse('文本字体字符集尚未映射');
    let text: string;
    try { text = new TextDecoder(encodings[charset], { fatal: true }).decode(bytes); } catch { return refuse('文本字符集或样式边界无效'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(text)) return refuse('文本不能表示为有效 XML');
    return text;
  };
  return (object: CdxObject, tag: number, bytes: Uint8Array, attributes: Record<string, string>, children: string[]): boolean => {
    if (tag === 0x0100) { children.push(readFonts(bytes)); return true; }
    if (tag === 0x0300) {
      const count = u16(bytes, 0); if (bytes.length !== 2 + count * 6) return refuse('颜色表长度无效');
      children.push(`<colortable>${Array.from({ length: count }, (_, i) => `<color r="${u16(bytes, 2 + i * 6) / 65535}" g="${u16(bytes, 4 + i * 6) / 65535}" b="${u16(bytes, 6 + i * 6) / 65535}"/>`).join('')}</colortable>`); return true;
    }
    if (tag === 0x080a || tag === 0x080b) {
      if (bytes.length !== 8) return refuse('默认文字样式长度无效');
      const prefix = tag === 0x080a ? 'Label' : 'Caption';
      for (const [i, name] of ['Font', 'Face', 'Size', 'Color'].entries()) attributes[prefix + name] = String(u16(bytes, i * 2) / (name === 'Size' ? 20 : 1));
      return true;
    }
    if ([0x0806, 0x0807, 0x0808, 0x0809].includes(tag)) {
      if (bytes.length !== 4) return refuse('线宽属性长度无效');
      attributes[({ 0x0806: 'BoldWidth', 0x0807: 'LineWidth', 0x0808: 'MarginWidth', 0x0809: 'HashSpacing' } as Record<number, string>)[tag]] = String(new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true) / 65536); return true;
    }
    if (object.tag === 0x8006 && tag === 0x0700) {
      const count = u16(bytes, 0), start = 2 + count * 10;
      if (start > bytes.length || !count) return refuse('没有显式字体样式的文本尚未映射');
      let previous = 0;
      for (let i = 0; i < count; i++) {
        const offset = 2 + i * 10, index = u16(bytes, offset), end = i + 1 < count ? u16(bytes, offset + 10) : bytes.length - start;
        if ((i === 0 && index !== 0) || index < previous || end < index || start + end > bytes.length) return refuse('文本样式索引无效');
        const font = u16(bytes, offset + 2), face = u16(bytes, offset + 4), size = u16(bytes, offset + 6) / 20, color = u16(bytes, offset + 8);
        children.push(`<s font="${font}" face="${face}" size="${size}" color="${color}">${esc(decode(bytes.subarray(start + index, start + end), font))}</s>`); previous = end;
      }
      return true;
    }
    return false;
  };
}
