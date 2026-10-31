# 归档（history）

本目录存放**已结束或已废弃**的设计与里程碑记录，仅供回顾，不是当前状态。

- 当前设计见 [`../runtime/P2MIND.md`](../runtime/P2MIND.md) 与 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)。
- 当前文档**不得**引用本目录内容；需要历史依据时，把结论写进当前文档。
- 本目录中的文档不再维护，可能包含与现状冲突的接口、版本与流程。

## 最近一次归档：P2Controller（2026-10）

P2Mind 取代了 P2Controller。归档的文件：

| 文件 | 原用途 |
|---|---|
| `P2CONTROLLER-v2.md` | 控制器设计（租约/承诺/槽位/交接） |
| `P2CONTROLLER-BODY-WIRING.md` | body 接线 |
| `P2CONTROLLER-IMPLEMENTATION-REPORT.md` | 实现映射与报告 |
| `KICKOFF-P2CONTROLLER-M0-M3.md` | 实施开场白 |
| `OP-PROVIDER-CONTRACT.md` | op/provider 契约 |
| `WS-FUTURE-transport.md` | WebSocket 传输与 owner 租约设想 |

归档原因：控制结构从“逐步操作 / 巨型脚本”改为 **NPC AI（P2Mind）**；旧接口（act/op/strategy artifact、租约、承诺）不再是当前实现路径。
