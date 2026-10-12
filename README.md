# Crush Monitor Agent

基于微信聊天记录的**关系感知与陪伴决策 Agent**。三栏界面：会话列表 / 聊天记录 / 顾问对话。

> 深度改造自 [FerryCorleone/crush-monitor](https://github.com/FerryCorleone/crush-monitor)（MIT），感谢原项目的解析与界面基础。

## 架构：双系统

| 系统 | 模型 | 职责 |
|---|---|---|
| **System 1 · 判断** | 本地小模型（Ollama 部署，推荐 JevK5 / qwen3:4b） | 逐条情绪、意图、事件、评分——毫秒级、零成本、可并行 |
| **System 2 · 生成** | 云端生成式模型（如 GLM-Flash） | 顾问对话、草稿体检、候选方案生成 |

评估与生成**分开配置、分开路由**：逐条分析走本地（免费、快），需要"动脑子"的生成走云端（质量）。

## 功能

- **微信记录导入**：chatlog 解密 → 应用内选择联系人同步（增量合并、自动去重）
- **多会话管理**：微信式三栏，会话独立保存/切换/删除，数据存本机磁盘
- **逐条分析**：情绪 / 意图 / 回复质量评分（可全部由本地模型执行）
- **整体概览**：好感度、关系阶段、下一步建议（自动 + 按月分段回溯）
- **顾问对话**：勾选任意聊天记录作为上下文，问"下一步怎么聊"、生成候选回复
- **场外信息**：现实事件、对方性格、MBTI 作为分析背景
- **自定义关系描述**：不限于三种预设关系
- 会话内搜索、微信表情码转 emoji、文本粘贴解析（微信/QQ/WhatsApp 格式）

## 环境搭建（新开发者从零到跑通）

### 前置要求

- Node.js ≥ 20、Git
- Windows（启动.bat 是批处理；其他平台手动执行等价命令）
- 可选：NVIDIA 显卡（本地评估模型用；没有也能用云端）

### 第 1 步：克隆与启动

```bash
git clone https://github.com/michaellu2007/crush-monitor-agent
cd crush-monitor-agent
npm ci
npm run build
npm start        # 或双击 启动.bat
```

打开 http://127.0.0.1:3178 。首次打开是未配置状态，正常。

### 第 2 步：配置两个模型（网页右上角 ⋯ → 聊天设置 → 模型设置）

**顾问模型（生成，必配）**：选服务商（如 智谱 GLM）→ 粘贴 API Key → 检测连接并保存。

**评估模型（判断，选配）**：跑在本地，免费无限次。先装 [Ollama](https://ollama.com)：

```powershell
# PowerShell 安装 Ollama
irm https://ollama.com/install.ps1 | iex

# 下载 JevK5 判断模型（约 2.7GB，国内走 hf-mirror）
curl -L -o jevk5-q4.gguf "https://hf-mirror.com/alibiserikbay/JevK5-GGUF/resolve/main/jevk5-4b-v0.3-Q4_K_M.gguf"

# 注册进 Ollama（在 jevk5-q4.gguf 所在目录）
"FROM ./jevk5-q4.gguf`nPARAMETER temperature 0" | Out-File -Encoding ascii Modelfile
ollama create jevk5 -f Modelfile
```

提速（强烈建议，实测 3 倍）：设置系统环境变量
`OLLAMA_FLASH_ATTENTION=1`、`OLLAMA_KV_CACHE_TYPE=q4_0`、`OLLAMA_NUM_PARALLEL=1`，重启 Ollama。

回到网页模型设置 → 勾选"**评估用本地模型**" → 地址填 `http://127.0.0.1:11434/v1`、模型 ID 填 `jevk5` → 保存。

### 第 3 步：导入微信聊天记录（可选，各用各的数据）

1. 本机微信已登录并使用过（本地生成过聊天数据库）
2. 用 [chatlog](https://github.com/sjzar/chatlog) 类工具解密出 `db_storage` 目录
3. 项目根目录建 `wechat-import.json`（含密钥，**已被 gitignore，永不提交**）：

```json
{
  "key": "你的解密密钥（64位hex）",
  "dataDir": "C:\Users\你\Documents\xwechat_files\你的wxid"
}
```

4. 网页左侧 ⊕ → "重新解密并刷新" → 选联系人导入

> 没有微信记录也能用：直接在中间粘贴聊天文本（支持微信/QQ/WhatsApp 复制格式）。

### 常见问题

- **端口 3178 被占用**：说明已在运行，直接开页面即可（程序会自动帮你打开）
- **GitHub 推送/拉取被重置**：`git config http.proxy http://127.0.0.1:你的代理端口`
- **本地评估很慢**：确认三个环境变量已设置并重启过 Ollama；跑批量时关掉吃显存的 Chrome 标签页
- **显存不足**：评估模型会自动部分回退 CPU，变慢但能用；或改用云端判断

## 数据与安全

- 所有会话与分析结果存在 **本机** `data/conversations/*.json`，不依赖浏览器存储
- `chats/`、`data/`、`wechat-import.json`、`*.log` 已被 gitignore，**永不提交**
- 聊天记录属于个人隐私，仓库保持 Private，数据永不外传

## 微信记录解密（可选）

需要本机已用 [chatlog](https://github.com/sjzar/chatlog) 类工具解密出 `db_storage`，并在
`wechat-import.json` 里配置解密密钥与数据目录（该文件含密钥，**永远不要提交或外传**）。

## 开发

```bash
npm test        # 81 项测试，交付前必须全绿
```

- 协作指引、里程碑、代码地图：**[开发主计划.md](./开发主计划.md)**
- UI 改动必须在浏览器实测；逐条分析禁止走云端大模型（协作约定）

## License

MIT（继承上游）
