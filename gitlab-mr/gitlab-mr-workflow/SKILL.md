---
name: gitlab-mr-workflow
description: 打通 DSH Agent 与 GitLab 的 MR 全流程：本地仓库建分支/提交/push(SSH)、用 glab 创建 MR 与回复评论、响应轮询插件注入的评论/合并事件做二次修改、合并后沉淀经验。
whenToUse: 需要让 agent 在本地仓库完成「改码 → 建独立分支 → 提交 → push → 建 MR → 响应评论区二次修改 → MR 合并 → 沉淀经验」的 GitLab 协作闭环时调用。
---

# GitLab MR 协作闭环

## 角色与分工

- **出站（你来做）**：本地仓库改码、git 建分支/提交/push（走 SSH）、`glab` 建 MR / 发评论 / 合并，建完 MR 用 `gitlab_watch_mr` 登记跟踪。
- **入站（插件负责）**：外部评论与合并由 `gitlab-mr` 插件检测，并以 user 消息注入到**登记该 MR 的那个会话**唤醒你。你收到这类消息时按本 skill 处理，不要自己用工具去轮询 MR。

## 环境前置（自托管 GitLab）

```bash
# 1) git 走 SSH，本地 .ssh/config 已有对应 Host（由部署者配置好）
# 2) glab 认证到自托管实例（第一次执行一次即可）
glab auth login --hostname <你的gitlab域名> --token "$GITLAB_TOKEN"
```

`GITLAB_TOKEN` 是 bot 账号的 Personal Access Token（scope 至少 `api`），由部署环境注入，不要写进任何文件。

## 标准流程

1. **建分支**（在本地仓库根目录）：
   ```bash
   git fetch origin && git checkout -b feat/<简短语义名> origin/main
   ```
2. **改码 + 提交**：正常使用 read/edit/write + bash，提交信息用约定式提交：
   ```bash
   git add -A && git commit -m "feat(scope): 一句话描述"
   git push -u origin <分支名>
   ```
3. **建 MR**（`glab` 用 PAT，不是 SSH）：
   ```bash
   glab mr create --source-branch <分支名> --target-branch main \
     --title "..." --description "背景/改动/测试情况" --yes
   ```
   MR 创建成功后会返回 `!<iid>` 编号。**立即登记跟踪**，让后续评论/合并自动唤醒本会话：
   ```
   gitlab_watch_mr(project="<group/repo>", mrIid=<iid>)
   ```
   登记之后**不要**自己用工具轮询 MR，等插件注入的「GitLab MR 评论 / 合并」消息即可。

## 响应评论区二次修改（插件注入「GitLab MR 评论」消息时）

1. 先 `git fetch origin && git checkout <你的分支>`。
2. 逐条理解评论，需要改就改 + 提交 + push（同一分支，不用新建）。
3. 每条处理完回复评论：
   ```bash
   glab mr note <iid> -m "已处理：<结论>"
   ```
4. 只回复有实质内容的评论；`system` 笔记和机器人自己的评论（插件已过滤）不要回。

## 合并与沉淀（插件注入「GitLab MR 合并」消息时）

1. 停止对该 MR 的任何后续操作。
2. **沉淀**：把本次可复用的结论写下来，落到本地仓库或约定的笔记位置，内容至少含：
   - 改了什么、为什么（一句话）
   - 踩过的坑 / 被评审指出的典型问题
   - 可复用的模板或检查项

## 约束

- 分支名、提交信息、MR 描述用中文或英文均可，但保持一致。
- push 到受保护分支、合并 MR 属于敏感写操作：先确认用户已授权，不要擅自 `glab mr merge` 或强推 `main`。
- 回复评论前必须先用 read 类工具核实相关代码，禁止空谈。
- Windows PowerShell 发中文 JSON body 会乱码：优先用 `glab`，不用 `curl` 手拼中文 body。