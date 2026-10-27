# WebSocket 与独立 body 后续方案

> 本文保留已讨论的本机 WebSocket、独立常驻 body、owner 租约及重连设计，供后续实现。首版采用插件托管的 stdio 子进程；本文不是首版开发门槛，也不代表 WS 已实现或验证。
>
> 关联：[首版协议](CONTRACTS.md#8-bridgebody-消息协议)、[插件生命周期](DSH-INTEGRATION.md)、[执行与停止](RUNTIME.md)。

## 1. 与首版的关系

消息协议和业务处理复用首版的 hello、describe、status、observe、check、activate、switch、stop、confirm、command.get 及事件。新增 WS 传输适配器之外，还需实现独立 launcher、服务发现、鉴权、多连接归属、租约恢复及发行验证；不能把后续工作描述为只替换管道即可完成。

后续拓扑为：人工启动的独立 launcher 持有 body，DSH bridge 附着它。插件退出后 body 可在 lease 内继续，授权到期则停止行为并保留服务用于诊断。一个 body、一个角色、一个可写 owner session；只读连接按配置授权。不接管用户 DSH agent 的生命周期。

## 2. 握手与鉴权

采用本机 WebSocket JSON 请求/响应/事件，默认仅 loopback，显式配置端口。随机配对令牌由人工配置、bridge 持有，不进入模型参数、提示或日志。远程部署、加密及远程鉴权另行设计。

首次 hello 不要求 bodyEpoch：bridge 提供支持的协议版本和配对凭据，body 返回选定协议、bodyEpoch、角色身份、当前 bindingId 及服务能力。鉴权握手不授予角色控制权；随后 attach 才授 owner。普通请求必须携带当前 epoch，不匹配即拒绝，不将旧请求自动重发到新进程。

requestId 对应一次网络往返，commandId 对应一次业务操作，leaseId 对应一次授权。普通请求继续使用统一消息信封，owner 方法额外校验 leaseId 与凭据；这些字段由可信 bridge 注入。会话归属从实际 DSH 上下文取得，同名 session 不能替代授权证明。

## 3. owner 租约与交接

状态为：无 owner → 有效租约 → 撤销中、等待收尾 → 无 owner。

- attach 只在没有有效 owner 且旧控制已收敛时授予租约；其他 session 不抢占。附着请求带 commandId，响应丢失时可以取回原结果，重复 attach 不延长租约。
- renew 仅延长有效租约，带递增 renewSeq；重复请求返回原处理结果，不重复延长。剩余时长由 body 单调时钟决定，客户端显示不构成授权证明。
- detach 立即撤销普通写权限、清空 pending switch、停止原运行；完成收尾后才释放 owner。lease 到期走同一路径。
- 清理故障保持撤销中及 faulted，不授予新 owner；旧凭据不能恢复已经撤销的租约。
- 同一 bridge 可在短暂断线且租约仍有效时凭原授权恢复连接，旧连接失去写权限。插件重载仍需人工 start，不自动恢复控制。
- 交接必须先停止旧行为并确认收尾，再授予新 leaseId。可以传递目标及执行摘要，不能继承旧运行控制、确认请求或令牌；“接受当前状态”不允许绕过停止。

heartbeat 2000ms、lease 10000ms 是保留的配置起点，不是保证；恢复连接、重复 attach 和凭据恢复须用丢响应场景验证。

## 4. 方法与结果草案

公共信封、业务方法及 D3/D4 的确切标识沿用首版协议，WS 增加以下管理语义：

| 方法 | 主要输入 | 主要结果 |
| --- | --- | --- |
| hello | 支持的协议版本、配对凭据 | 选定协议、epoch、角色、binding、能力。 |
| attach | commandId、可信 session 归属；恢复时附原授权证明 | leaseId、授权凭据、剩余时长。 |
| renew | leaseId、renewSeq | 续期处理结果及剩余时长。 |
| detach | commandId、leaseId | 受理结果及最终释放结果。 |
| describe / status | 可选目标 binding 或状态查询 | 静态声明、owner、health、connection、activeRun、pending、待确认记录及游标。 |
| observe | 查询声明、参数、时效要求 | 值和元数据，或明确错误；零隐藏重试。 |
| check | commandId、源码路径/摘要、目标 binding、精确依赖 | 检查报告及 artifactId。 |
| activate / switch | commandId、artifactId；switch 另含参数 | 启用结果或切换的最终 started/rejected/superseded。 |
| stop | commandId、明确 runId | 停止结果或 alreadyTerminal，不误停后来的 run。 |
| confirm | commandId、runId、confirmationId、决定及依据 | 最终决定或拒绝原因；来源由可信通道确定。 |
| command.get | commandId | 命令阶段及最终结果；无记录返回未知。 |
| events.subscribe / events.ack | 游标 | 至少一次事件及缺口说明；ack 只代表 bridge 已接收保存。 |

命令状态保留 accepted、pending、completed、rejected、superseded。completed 是命令完成，不代表 behavior 成功；切换完成表示新 run 已开始，停止未获收尾证明时仍 pending 并附故障。具体 WS 字段 schema 和凭据机制在实现该阶段前验证。

同 commandId 同业务内容返回原结果，不同内容拒绝；摘要包括方法、目标与参数，不包括 requestId 或连接凭据。先鉴权再查结果。未知命令不等于从未执行，不自动换新 commandId 重做；新 epoch 不重放旧命令。D6 首版仅提供调试日志与有界内存记录；本方案的持久通知、可靠 ack 和跨崩溃对账另列为[后续恢复能力](FEEDBACK-AND-RECOVERY.md#7-异常退出与后续恢复功能)，须在实现前重新确定存储与预算，不能直接依赖首版日志。

## 5. 重连与事件

1. 重新 hello，比较 bodyEpoch。
2. 同 epoch 且 lease 有效时恢复授权，查询 status 和未完成命令。原待确认 run 及 owner 仍有效时可取回同一 confirmationId。
3. status 返回对应快照的事件游标，从该位置继续订阅，避免查询与订阅间漏事件。
4. 游标超出保留范围返回 EVENT_GAP，获取新状态，不补造漏失事实。
5. epoch 改变时旧授权失效，先查看恢复/对账状态，再人工附着；旧控制和确认请求不重放。

bridge 保存事件及游标到自己的 pending 队列后才 ack；ack 不代表模型已读或目标验收完成。重复事件按 ID 去重，关闭请求的积压通知不得再次成为待办。重连不承诺跨系统 exactly-once。

## 6. 后续实施门槛

验证 launcher 在 DSH 退出、窗口关闭、重启和升级时的行为；验证授权撤销、凭据恢复、双连接竞争、旧连接拒绝、续期重发、事件缺口和命令对账。只有这些验证通过后才能启用独立常驻部署；stdio 首版仍须独立满足控制清理、进程回收和不自动启动的验收。
