# 引擎适配验证

`browser-results.json` 记录 26 份实际下载的 CDX/CDXML：四个模板、三种自由基自旋态、三种单键显示、两种双键偏侧及外部连接点。包括重新导入、源格式保存、排版撤销／重做和属性面板操作。

`independent-results.json` 记录 RDKit 2025.03.6 独立读取 24 份化学文件的结果。两份外部连接点文件不计作独立化学验证成功，因为该 RDKit 版本会把顶层连接点误读为碳；连接点由模型、XML 属性和浏览器测试覆盖。自由基电子数验证不认证单重／三重态区分，字段往返由本项目测试核对。

`corpus-results.json` 是本机 ChemDraw 26 安装包的逐文件回归。687 份输入排除 2 份正文明确为故意无效输入的文件后，685/685 份通过导入、原始取回及所有适用编辑的源保存回读：579 份化学修改、139 份图元修改、28 份反应角色修改、1 份空白文档新增结构；类别有重叠。比较稳定 ID 归一化后的化学、绘图、文字样式、引用和反应模型。安装包原文件未复制到此目录。

`document-browser-results.json` 记录 7 份复杂文件通过浏览器真实导入、可见属性编辑、撤销重做、实际下载和下载文件回读。实际模型测试仍不证明任意操作均受支持；3 处来源缺失内部图的命名标签明确标为未定义，部分专用图元仅显示轮廓。见 [验证范围与边界](../../engine-upgrade.md)。

立体几何的 10 份新增文件与独立构型验证见 [stereochemistry](../stereochemistry/README.md)。改造说明见 [引擎升级](../../engine-upgrade.md)。

```powershell
node scripts/validate-chemdraw-adaptation-browser.mjs
python scripts/validate-chemdraw-adaptation.py --dependencies .local/cdx-reference/validation-deps
node --expose-gc scripts/audit-chemdraw-corpus.mjs .local/chemdraw26-unpacked/files docs/validation/chemdraw26/corpus-results.json
node scripts/validate-document-browser.mjs
```
