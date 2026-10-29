# behavior IR 参考（v1 小内核）

> 本文是 v1 behavior IR 的单一参考：节点、表达式、求值语义、预算与示例。IR 是可序列化的数据，由可信执行器运行；作者用什么语言生成它不影响运行语义。契约级定义见[接口契约 §3](../CONTRACTS.md#3-behavior-模块与构建产物)，调度规则见[运行时 §3—§4](../RUNTIME.md#3-每轮调度与资源上限)。
>
> **v1 只包含本文第 2—4 节列出的内容。**第 9 节列出被推迟的候选能力，它们不属于本轮实现，也不应被当作已定契约。验证计划见[M5 验证计划](../history/M5-VALIDATION.md)。
> **实验提示（2026-10-28）**：本文仍是 `dev` 的当前实现；behavior 层的 IR vs 受限 JS 对照实验见[实验计划](EXPERIMENT-BEHAVIOR-SUBSTRATE.md)与[JS 架构草案](../BEHAVIOR.md)，实验结论前不改变本文契约。

## 1. 结构

```text
BehaviorDefinition
├─ id / description / mode
├─ parameters   启动时求值一次，实例内只读
├─ locals       实例私有，跨轮次保留；未给初值为「未就绪」
├─ root         Node 树
├─ completion   predicate（有限必须）或 externalConfirmation
└─ progress     只用于上报进度与可读性
```

- `mode`：`finite` 必须声明 completion；`continuous` 禁止 `predicate` completion。
- IR 内没有闭包、函数或模块引用；运行期计算只有内建表达式与 `decide` 调用的 policy。
- 节点 id 在整棵树内唯一；禁止共享或循环对象引用。

## 2. 节点（v1 共 12 种）

| kind | 关键字段 | 语义 | 占控制权 |
| --- | --- | --- | --- |
| `sequence` | `children[]` | 记住位置，成功后推进下一个；失败向上传播。 | 否 |
| `if` | `when`、`then`、`else?` | 进入时求值一次，之后不重选。 | 否 |
| `reactivePriority` | `branches[{when, child}]` | 有序 guard，首个 true 命中；分支切换必须先确认旧分支收尾。 | 否 |
| `repeat` | `child`、`count?` | 子节点成功后**下一 tick** 新建子运行；有限 0 次成功。 | 否 |
| `assign` | `target`、`value` | 求值并校验后原子替换 local。 | 否 |
| `query` | `query{op,args,freshnessMs?,timeoutMs?}`、`output` | 一次请求；成功且通过时效校验才写输出。 | 否 |
| `act` | `act{definitionId,artifactId}`、`args`、`output?` | 唯一占控制权的节点；成功输出须等收尾确认。 | **是** |
| `subtree` | `tree`、`inputs`、`outputs` | 构建期内联展开，运行期独立帧。 | 否 |
| `wait` | `durationMs` | 单调时间等待，不阻塞调度。 | 否 |
| `recover` | `child`、`rules[{codes,retries,intervalMs,deadlineMs,fallback?,blocked?}]` | 只捕获列出的错误码；未列出直接传播。 | 否 |
| `decide` | `policy{definitionId,artifactId}`、`inputs`、`output`、`timeoutMs?` | 调用一次 policy，把决策写入 local；异步等待。 | 否 |
| `fail` | `code`、`message`、`category?` | 计划主动以业务原因失败。 | 否 |

### 2.1 `decide`

```json
{
  "kind": "decide",
  "id": "pick",
  "policy": { "definitionId": "pick-nearest", "artifactId": "p2:policy:…" },
  "inputs": { "drops": { "kind": "local", "name": "drops" } },
  "output": "decision",
  "timeoutMs": 200
}
```

- 进入时求值 `inputs` 并固定；提交一次请求，**不在 tick 内同步等待**；期间节点为 running，执行器继续推进取消、失联与清理。
- 结果必须是通过校验的受限 JSON，写入 `output`；上一轮的值不能冒充本轮结果。
- 失败：`POLICY_FAILED`、`POLICY_TIMEOUT`、`POLICY_RESULT_INVALID`，节点失败；不重试、不缓存跨轮结果。
- 取消：丢弃等待中的请求，晚到结果不写入。
- policy 拿不到 locals 引用，也不能提交 op；它只回答「值/决策是什么」。

### 2.2 `fail`

```json
{ "kind": "fail", "id": "no-target", "code": "NO_CANDIDATE", "message": "no reachable target remains" }
```

- 立即以给定 `code`/`message` 失败，`category` 默认 `runtime`；`recover` 可按 `code` 捕获。
- 用于计划层面的业务判断（无候选、资源不足、放弃），不能替代 act 的环境失败。
- 不得被“目标已达成”的证据掩盖：它与程序/契约错误一样优先于普通环境失败。

## 3. 表达式（v1）

| kind | 字段 | 说明 |
| --- | --- | --- |
| `literal` | `value` | 受限 JSON 字面量。 |
| `param` | `name` | 启动参数；缺失报 `PARAM_MISSING`。 |
| `local` | `name` | 局部槽位；未就绪报 `UNINITIALIZED_VALUE`。 |
| `member` | `object`、`key` | 对象按键、数组按非负整数下标；缺失报 `EXPRESSION_ERROR`。 |
| `record` | `fields` | 构造对象。 |
| `array` | `items` | 构造数组。 |
| `binary` | `op`、`left`、`right` | `eq/neq/lt/lte/gt/gte/and/or/add/sub/mul/div`。 |
| `not` | `value` | 仅接受布尔。 |
| `length` | `value` | 数组、字符串或对象的成员数；其他类型报 `EXPRESSION_ERROR`。 |

求值规则：

| 情况 | 结果 |
| --- | --- |
| `eq`／`neq` | 按规范化 JSON 比较，不比较引用。 |
| `lt`／`lte`／`gt`／`gte` | 仅两个 number 或两个 string。 |
| `add` | 两个 number，或两个 string 拼接。 |
| 其他算术 | 仅有限数值；结果不是 `NaN`／`Infinity`。 |
| `div` 除数为 0 | `EXPRESSION_ERROR`。 |
| `member` 数组越界或非整数 | `EXPRESSION_ERROR`。 |
| `not` 非布尔 | `EXPRESSION_ERROR`。 |

集合筛选/排序/评分、距离与资源分配属于 policy 的职责，不属于表达式。需要新计算时先问：它能否用一次 `decide` 解决；不能才讨论扩展表达式。

## 4. 条件与完成

```ts
type Condition =
  | { kind: "expr"; expr: ValueExpr }
  | { kind: "query"; query: QueryRef; test: ValueExpr };

type CompletionRule =
  | { kind: "predicate"; condition: Condition; checkMs?: number }
  | { kind: "externalConfirmation"; description: string };
```

- 条件结果：`true`、`false`、`unknown`、`failed`。**unknown 不是 false**。`query` 条件的 `test` 在一个绑定 `result`（本次查询值）的局部副本上求值，因此可以写 `local('result')`。
- 查询条件在证据仍新鲜且参数未变时可复用；过期或参数变化才新建请求。
- 有限 behavior 的完成条件在**进入时、根结束时、以及每次启动新 act 前**检查；达成后锁定「准备成功」，停止活动子树并收尾。
- 这条检查是「循环到某种状态就停」的表达方式：`repeat` 不需要额外的 break 节点。

## 5. 数据与时效

每次写入产生 `ValueMeta`：

```ts
type ValueMeta = {
  source: "initial" | "assign" | "query" | "act" | "subtree";
  scope: string;
  sampledAt: number;
  validUntil?: number;
  evidence?: string[];
  serverAge?: number;
  paused?: boolean;
};
```

- 查询输出与决策消费时校验年龄与作用域；过期返回 `STALE_OBSERVATION`，无法证明年龄返回 `FRESHNESS_UNPROVABLE`。
- 观测值经 `assign`、`call`/子树的传递后保留最保守年龄；复制或计算不刷新时间。
- 策略计数（「已成功采集 3 次」）是执行证据，不是当前观测，不套用观测有效期。

## 6. 预算

| 限制 | 初值 | 触发 |
| --- | --- | --- |
| 节点总数 | 10000 | 构建/检查拒绝。 |
| 深度（含 subtree） | 64 | 构建/检查拒绝。 |
| 每轮节点转移 | 200 次 / 10ms | 让出，本轮不失败。 |
| 查询期限 | 1000ms 默认 | `QUERY_TIMEOUT`，零重试。 |
| `decide` 单次 | 200ms 无响应 | `POLICY_TIMEOUT`。 |
| act 总时长 | 30s 默认 | `ACT_TIMEOUT`，走收尾。 |

## 7. 示例

### 7.1 当前形态（M4）

[behaviors/approach-target.mjs](../../behaviors/approach-target.mjs) 是真实存在的 IR 字面量：`sequence(moveTo, stop, assign phase)`，`completion` 读 `phase`。它的 `act` 写的是 op 名 `moveTo`——这是 M4 的旧形态，G1 会改为 `ActRef`。

### 7.2 有限配额：`decide` + `fail` + 完成条件

```json
{
  "id": "gather-quota",
  "mode": "finite",
  "parameters": {
    "want": { "type": "number", "required": true },
    "targets": { "type": "json", "required": true }
  },
  "locals": {
    "stock": { "type": "number" },
    "pick": { "type": "json" },
    "done": { "type": "number", "initial": 0 }
  },
  "root": {
    "kind": "repeat", "id": "loop",
    "child": {
      "kind": "sequence", "id": "step", "children": [
        { "kind": "query", "id": "q-stock", "query": { "op": "inventory", "args": {} }, "output": "stock" },
        { "kind": "decide", "id": "d", "policy": { "definitionId": "pick-target", "artifactId": "p2:policy:…" },
          "inputs": { "targets": { "kind": "param", "name": "targets" }, "stock": { "kind": "local", "name": "stock" } },
          "output": "pick" },
        { "kind": "if", "id": "have",
          "when": { "kind": "expr", "expr": { "kind": "binary", "op": "eq",
            "left": { "kind": "member", "object": { "kind": "local", "name": "pick" }, "key": { "kind": "literal", "value": "kind" } },
            "right": { "kind": "literal", "value": "target" } } },
          "then": { "kind": "sequence", "id": "mine", "children": [
            { "kind": "act", "id": "dig", "act": { "definitionId": "mine-one", "artifactId": "p2:act:…" },
              "args": { "pos": { "kind": "member", "object": { "kind": "local", "name": "pick" }, "key": { "kind": "literal", "value": "pos" } } } },
            { "kind": "assign", "id": "inc", "target": "done", "value": { "kind": "binary", "op": "add",
              "left": { "kind": "local", "name": "done" }, "right": { "kind": "literal", "value": 1 } } }
          ] },
          "else": { "kind": "fail", "id": "short", "code": "INSUFFICIENT_RESOURCE", "message": "no more targets" } }
      ]
    }
  },
  "completion": { "kind": "predicate", "condition": { "kind": "expr", "expr": { "kind": "binary", "op": "gte",
    "left": { "kind": "local", "name": "stock" }, "right": { "kind": "param", "name": "want" } } } }
}
```

注意：库存达标时，新 act 启动前的完成条件检查会拦截下一次采集；`fail` 处理资源耗尽；循环本身由 `repeat` 承担。

### 7.3 持续巡逻：业务状态 + `decide`

```text
root = repeat(sequence(
  decide(position, route, leg) -> next,
  act moveTo(next.pos),
  query(position) -> here,        // 到达确认
  wait(500),
  assign(leg = next.index)
))
```

「下一个航点」是业务状态；不要引入 `programCounter` 之类模拟执行位置的状态。

## 8. 常见错误

| 写法 | 问题 | 正确做法 |
| --- | --- | --- |
| `act` 里写 `"moveTo"` | op 名不是 act 产物引用 | 引用 act 的 definitionId；源码可省略 artifactId，检查时按启用映射解析，产物中必须含确切 id |
| behavior 里出现 ControlOp | 违反控制路径 | 把控制放进 act |
| 用 `recover` 把“达标”伪装成循环出口 | 完成条件是出口，不是异常 | 用 completion，不用失败 |
| 用表达式错误表示“无候选” | 业务失败不是程序错误 | 用 `fail` 节点 |
| 用 `local` 读未初始化槽位 | `UNINITIALIZED_VALUE` | 声明 initial 或先 assign |
| 把「曾经采集过」当成「现在背包里有」 | 执行证据不是当前观测 | 重新查询背包 |
| 在 guard 里做复杂计算 | guard 会每 tick 求值 | 用 `decide` 在动作前算一次 |

## 9. 推迟的候选能力（不属于 v1）

以下能力在 G2 验证后按证据决定，当前不实现、不作为契约：

| 候选 | 用途 | 进入条件 |
| --- | --- | --- |
| `forEach` | 遍历快照并逐项执行动作 | 至少两个场景需要“快照枚举”，且无法用 `repeat` + `decide` 清楚表达 |
| `call` | 引用另一个 behavior 产物 | 出现跨 behavior 的稳定复用需求；先与 `subtree` 语义合并 |
| `select` | 在表达式内取集合极值 | 简单选择无法移到 policy，且反复出现在多数场景 |
| `aggregate` | 聚合 | 同上 |
| `unary` 数学（abs/floor/ceil/mod/min/max） | 数值计算 | 同上 |
| policy 作为表达式 | 在表达式任意位置调用 | 已否决：跨进程调用不可放进同步表达式，且会把选择拆成多次调用 |

扩展规则：一次只加一个，且必须有场景证明现有内核无法清楚表达；不得为“以后可能用到”预先添加。

## 10. 构建与检查

- 构建期可用宿主语言做循环、函数与展开，但只生成静态图，不读游戏状态。
- 检查覆盖：节点结构、id 唯一、引用类型、表达式类型、`act` 引用与依赖闭包、`decide` 的 policy 引用、`fail` 的 code 非空。
- 检查不证明目标可达、策略正确或代码安全；这些由运行时与真实反馈验证。
