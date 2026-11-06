"""Publish only our generated engine validation files to the local manual test page and ZIP."""
from pathlib import Path
from shutil import copy2
from html import escape
from zipfile import ZipFile, ZIP_DEFLATED

root = Path('public/test-files')
groups = [('chemdraw26', '06-engine-adaptation', '自由基、连接点与键描绘'),
          ('stereochemistry', '07-stereochemistry', '四面体与双键构型'),
          ('document-model', '08-document-editing', '反应步骤、内部片段与多页文档'),
          ('chemistry-engine', '09-chemistry-engine', '二维清理、分子性质与 SMILES（40 份）'),
          ('polymers', '10-polymers', '聚合物括号组、重复次数与跨括号连接（8 份）'),
          ('expansion', '11-abbreviation-expansion', '缩写原子级展开、端口连接与立体构型（12 份）'),
          ('collapse', '12-abbreviation-collapse', '选区收起、可编辑缩写与再展开（18 份）'),
          ('rxn', '13-rxn', 'RXN 双版本反应、试剂与原子映射（12 份）'),
          ('expanded-groups', '14-expanded-groups', '残基、备选及引用片段的群组展开与编辑（10 份）'),
          ('query-constraints', '15-query-constraints', '高级查询条件、键拓扑及跨格式保存（70 份）')]
sections, notes = [], []
for source, folder, title in groups:
    target = root / folder
    target.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in (Path('docs/validation') / source).iterdir() if p.suffix in ('.cdx', '.cdxml', '.rxn'))
    rows = []
    for p in files:
        copy2(p, target / p.name)
        href = f'{folder}/{p.name}'
        rows.append(f'<tr><td>{escape(p.stem)}</td><td><a download href="{href}">{escape(p.name)}</a></td></tr>')
    sections.append(f'<h2>{folder} · {title}</h2><table><thead><tr><th>样例</th><th>下载</th></tr></thead><tbody>{"".join(rows)}</tbody></table>')
    formats = '／'.join(sorted({p.suffix[1:].upper() for p in files}))
    notes.append(f'- {folder}/：{len(files)} 份 {formats}，{title}。')

instructions = ('tetra-original 为 S，tetra-inverted 为 R，tetra-mirrored 整体镜像后仍为 S；'
                'alkene-trans 为 E，alkene-cis 为 Z。以上标签由独立 RDKit 验证；普通分子可在“化学计算”中重新计算常见 CIP 标签。'
                '导入后选择中心原子或双键，打开右侧“结构”标签，查看连接顺序并点击反转；再测试撤销、重做和源格式保留保存。'
                '已记录约束的删除或改键级可能被阻止，请先清除相关约束。模板外部连接点显示为菱形，不是碳或查询通配原子。'
                '09 目录可导入 before 文件，打开“化学计算”，点击自动二维清理，再与 clean 文件对照；另可测试性质、立体标签和 SMILES 输入。'
                '10 目录导入 original 文件，在右侧“结构”的文档对象中选择 bracketedgroup，修改重复次数、类型、连接模式、成员及边界键，测试源保存和撤销。'
                '11 目录导入 original 文件，选择缩写节点，点击“展开一层到主画布”或“递归展开当前缩写”；对照 expanded 文件，测试撤销和源格式保存。'
                '12 目录导入 original 后选择连通片段，在“收起为缩写”输入名称并收起；也可导入 collapsed，打开内部编辑或展开。'
                '13 目录导入 .rxn，检查反应物／产物／试剂和映射；修改后选择明确的 RXN V2000/V3000 导出，不能把图元或文字条件静默转成试剂。'
                '14 目录导入 original 后选择片段，点击“展开结构并编辑”；点击卡片中的真实原子或键进行修改并保存。alternatives 会展示全部候选，nested 可展开全部内部层级；expanded 文件已保存展开状态。'
                '15 目录导入 native 文件，选择C原子并展开“高级查询条件”，测试取代数0/255、环键数、不饱和和反应条件；选择键测试“键拓扑查询”。edited/converted为修改与跨格式输出，cleared已清除条件。测试保存回读、撤销重做，含查询时不会计算为确定分子。')
page = root / 'index.html'
base = page.read_text(encoding='utf8').split('<!-- engine-upgrade-tests -->')[0].replace('</html>', '').replace('0x0445', '0x044a')
page.write_text(base + '<!-- engine-upgrade-tests --><h2>引擎升级测试</h2><p>' + instructions + '</p>' + ''.join(sections) + '</html>\n', encoding='utf8')
readme = root / 'README.md'
base = readme.read_text(encoding='utf8').split('\n## 引擎升级测试样例')[0].replace('0x0445', '0x044a')
readme.write_text(base + '\n## 引擎升级测试样例\n\n' + '\n'.join(notes) + '\n\n' + instructions + '\n', encoding='utf8')
archive = root / 'molecule-test-files.zip'
with ZipFile(archive, 'w', ZIP_DEFLATED) as z:
    for p in sorted(root.rglob('*')):
        if p.is_file() and p != archive:
            z.write(p, p.relative_to(root).as_posix())
print(f'Prepared {sum(sum(p.is_file() and p.suffix in (".cdx", ".cdxml", ".rxn") for p in (root / folder).iterdir()) for _, folder, _ in groups)} new test files and refreshed ZIP.')
