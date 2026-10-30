# 文档目录规则

- `docs/` 下的文档描述项目**当前**状态、契约与计划；读到它们就应当知道项目现在是什么样。
- 运行时改造设计在 `docs/runtime/`（operation/provider 契约、P2Controller）；面向 agent 的操作指令在仓库根的 `prompts/`（不属于 `docs/`，因为它不是设计文档）。新 session 的实施开场白是 `docs/runtime/KICKOFF-P2CONTROLLER-M0-M3.md`。
- `docs/history/` 存放里程碑记录与已结束阶段的文档，**仅供回顾**。
- `docs/` 下的文档**不得**链接或引用 `history/` 的内容；需要历史依据时，把结论写进当前文档，不搬历史叙述。
- 文档不记录决策过程（"经过某次实验决定……"这类内容属于 `history/`）；当前文档只写"是什么、为什么这样定"的稳定结论。
- 阶段收尾时，把该阶段的记录移入 `history/`，并在同一次提交里更新 `docs/` 下的当前状态。
