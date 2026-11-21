# Crush Monitor Agent

本地优先的聊天记录关系感知工具：粘贴聊天记录 → 本地解析 → 逐条情绪 / 意图分析 → AI 顾问对话。
三栏界面：会话列表 / 聊天记录 / 顾问对话。

> 深度改造自 [FerryCorleone/crush-monitor](https://github.com/FerryCorleone/crush-monitor)（MIT），感谢原项目的解析与界面基础。
> AI 不了解你们的真实关系与聊天之外的背景——分析结果仅供参考视角，你自己的判断和坦诚沟通更重要。

## 功能特性

- **粘贴导入**：支持微信复制记录、QQ、WhatsApp 文本导出等多种格式解析
- **逐条分析**：12 类情绪、指向归因（对你 / 对 TA / 第三方）、35 类意图，各取前三概率
- **会话总览**：好感度五维评分、关系阶段、情绪水位曲线、下一步行动建议
- **顾问对话**：勾选记录向 AI 提问，生成 2-3 个候选回复并标注门槛 / 温度 / 风险
- **主动预警**：连续冷淡、水位回落、邀约悬空、对方骤降四条本地规则
- **隐私设计**：聊天记录只存本机；分析仅发送必要片段给模型接口；单页面锁防多开

## 下载完整版（Windows exe）

[Releases](https://github.com/michaellu2007/crush-monitor-agent/releases) 提供 Windows 免安装版：
包含微信聊天记录导入、表情包展示等**闭源能力**——保持微信登录，双击即可导入。
exe 全新无用户数据，数据默认存放在 exe 旁的 `data/` 目录。

## 开源版与完整版的差异

本仓库不含微信自动导入 / 表情下载的源码（该部分随 exe 闭源分发）。
粘贴导入、分析、顾问、预警等其余功能全部开源可复现。

## 快速开始

```bash
npm install
npm run build   # tsc --noEmit + vite build，产物 dist/
npm start       # 生产启动，访问 http://127.0.0.1:3178
npm test        # 单测
```

模型配置：启动后在应用内「模型设置」填写（支持任意 OpenAI 兼容端点），
或参考 `.env.example` 直接写 `.env`。

## 项目结构

```
src/     React + Vite 前端（界面、状态机、持久化客户端）
server/  Express + tsx 后端（分析引擎、模型适配、存储）
shared/  前后端共享纯函数（解析、切分、聚合、类型）
tests/   单测
```

## 许可

[MIT](./LICENSE) · 源自 [FerryCorleone/crush-monitor](https://github.com/FerryCorleone/crush-monitor)
