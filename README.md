# 文本批注与写作批改 (Tavern Proofreader)

用于酒馆（SillyTavern 与 TauriTavern）的划词批注与写作批改扩展，支持桌面端与移动端。

---

## 功能说明

1. **划词交互与修改**
   - 鼠标划选或移动端长按 AI 消息中的文本，呼出批改按钮。
   - 原地微调：直接在原句输入框中修改字句，自动生成增删对比（Unified Diff）。
   - 指导意见：可为修改附加写作说明（如调整叙事节奏、补充动作细节等）。
   - 原文高亮：被批注的句子在原消息中显示高亮标记，点击可快速定位下方对应的批注便签。

2. **零额外模型调用**
   - 不调用额外的审核接口或总结模型，不增加额外 API 费用。
   - 批改记录作为一条用户消息直接插入对应楼层正下方，便于随时复盘阅读。
   - 同一楼层多次修改自动合并展示，条目清晰。

3. **动态提示词索引**
   - 下一轮发送消息时，插件会在请求中临时向用户输入末尾追加最近轮次的批注索引（如 `[批注历史: 第 14 楼 (2 轮前)]`）。
   - 提示词索引仅在单次请求中生效，不污染实际保存的聊天记录，不干扰原有预设结构。

4. **状态维护**
   - 支持多分支（Swipe）：切换分支时自动隐藏不匹配的批改与高亮，切回后自动恢复。
   - 编辑容错：原文若被手动修改，通过文本三元组算法尽量重新定位高亮位置。
   - 单条撤销：可在便签中随时删除某条修改并同步清除对应高亮。

---

## 安装方法

### 方式 1：从酒馆面板在线安装（推荐）
在 SillyTavern 扩展管理页面中，选择 **从 URL 安装扩展**，输入仓库地址：
```text
https://github.com/DeconstructedCube/tavern-proofreader
```
点击安装后启用即可。

### 方式 2：手动克隆安装
```bash
# SillyTavern
cd public/scripts/extensions/third-party/
git clone https://github.com/DeconstructedCube/tavern-proofreader.git

# TauriTavern 用户目录
cd data/default-user/extensions/
git clone https://github.com/DeconstructedCube/tavern-proofreader.git
```
