# 立体几何验证

本目录的 10 个 CDX/CDXML 文件均为项目独立构造的测试结构，通过真实浏览器的导出对话框下载，不含 ChemDraw 安装包样本。

| 文件前缀 | 结构与独立读取结果 |
| --- | --- |
| tetra-original | C 连接 F/Cl/Br/I，原始实楔，RDKit 判为 S |
| tetra-inverted | 属性面板反转，同步调整排序与楔键，RDKit 判为 R |
| tetra-mirrored | 整体水平镜像，同步翻转楔键深度，仍为 S |
| alkene-trans | 原始反式 2-丁烯，RDKit 判为 E |
| alkene-cis | 属性面板反转双键，镜像一侧支链，RDKit 判为 Z |

`browser-results.json` 记录下载回读、源保存、撤销／重做、无效编辑回滚与页面异常检查。`independent-results.json` 使用 RDKit 2025.03.6 读取实际二进制 CDX 与 XML，独立检查手性、双键构型、原子键数量和异构 SMILES。`editor.png` 为真实工作台截图。

复现：

```powershell
npm test
npm run build
npm run dev
node scripts/validate-stereochemistry-browser.mjs
python scripts/validate-stereochemistry.py --dependencies .local/cdx-reference/validation-deps
```

Playwright 可通过浏览器脚本的第一个参数指定模块 URL。这组历史验证脚本使用独立的原生 RDKit 复核输出；当前产品另已接入浏览器 RDKit，为普通完整分子计算常见 R/S/E/Z，见 [计算验证](../chemistry-engine/README.md)。以上均不表示已验证全部立体类别或商业 ChemDraw 的排版。
