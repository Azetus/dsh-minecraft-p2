# dsh-minecraft-p2

[简体中文](README.md) | English

Let DeepSeek Harness (DSH) join your Minecraft world as a **second player**. You can chat with P2 in-game and ask it to go somewhere, mine, or pick up dropped items. Once it takes on a task, P2 finds its own route, chooses tools, and tries to reroute or retry if it gets blocked.

P2 joins the server as a separate player. No client mod is required. This release supports **Minecraft Java Edition 1.21.1** servers that allow offline login (`online-mode=false`).

> **0.2.x preview** · Some features are still in development, and commands and tool parameters may change between releases.

## Features

- **Task execution** · P2 works toward a goal in-game and reports to DSH when the task finishes, gets blocked, or fails.
- **Block placement and gathering** · P2 can place blocks at specified locations and gather materials by mining blocks and picking up drops.
- **Survival and self-care** · By default, P2 tries to retreat from danger, eat when hungry, and free itself when stuck. You can opt in to automatic combat.
- **Personality and memory** · Use `.p2/persona.md` to set how P2 speaks and whether it treats players' messages as instructions. P2 keeps separate memories for each world and character.

## Compatibility

The plugin uses Mineflayer over the vanilla Java protocol. Whether it can connect depends on whether the server accepts a vanilla client, not on whether a mod is labeled client-side or server-side.

### Minecraft versions

- **Stable support: Java Edition `1.21.1`.** This is the tested scope.
- The protocol library also supports versions up to `26.1`. We have only run a quick test on `26.1`; that is not stable support, and tool behavior is not guaranteed there.
- **Protocol support does not equal stable plugin support.** Other versions may allow login, but movement, mining, placement, crafting, and other behavior are not guaranteed.
- Java Edition only; Bedrock is not supported.
- `minecraft.version` in `.p2/config.json` must match the server version; the default is `1.21.1`.
- Offline login only (`online-mode=false`); servers that require Mojang/Microsoft authentication are not supported.

### Mods and servers

Usually works:

- Vanilla or offline servers.
- Servers that do not require client mods and do not send unregistered custom payloads to clients.
- Client-side visual, HUD, or map mods that do not send protocol data when a player joins.

May fail:

- Servers that require specific client mods or enforce a mandatory mod handshake.
- Servers that send custom payloads a vanilla client does not understand when a player joins. Even a mostly client-side mod can trigger this in a LAN integrated world through its server-side component.
- Servers that deeply change blocks, items, recipes, dimensions, registries, or world synchronization.

### Interaction scope

Being able to log in does not mean modded content works.

Mineflayer only knows the vanilla blocks, items, recipes, and entities in its protocol data. Modded content may appear as unknown or air-like objects and cannot be reliably mined, placed, crafted, or interacted with. On modded servers:

- Prefer operating on vanilla content.
- Or treat the server as a “can log in, but cannot reliably interact” container.

## Installation

### Requirements

- An installed copy of DSH. This plugin was tested with DSH `0.2.1-rc.3`.
- A reachable Minecraft Java Edition `1.21.1` server with `online-mode=false`.
- A unique name for P2. The default is `P2_Bot`. Make sure no player with that name is already connected.

### Install from the DSH Plugins page

1. In the DSH sidebar, open **Plugins** (插件), then select **Add Plugin** (添加插件).
2. Enter **`dsh-minecraft-p2`** to install the default release or **`dsh-minecraft-p2@<version>`** to install a specific version. To use a local `.tgz` package, enter its absolute path.
3. Confirm the installation. If prompted to enable the plugin, confirm it.

### Install from the DSH command line

To install the default release, run the following command.

```text
dsh plugin --profile web add dsh-minecraft-p2
```

Replace `web` with your DSH profile. The desktop app typically uses `desktop`. To install a specific version, use `dsh-minecraft-p2@<version>` as the package name.

To install a local `.tgz`, pass its absolute path. Quote paths that contain spaces, and replace `<version>` with the actual version.

```text
dsh plugin --profile web add "/absolute/path/dsh-minecraft-p2-<version>.tgz"
```

After installing or upgrading, quit DSH completely and restart it to load the plugin.

## Quick start

Open a DSH session with a project directory. You can run `/p2 setup` to check the session's project directory.

In the same session, run `/p2 start` with your Minecraft server's address and port in place of the example below.

```text
/p2 start 127.0.0.1:25575
```

The first run creates `.p2/` and its default configuration in the project directory. Once connected, check that `P2_Bot` appears in the Minecraft player list and try saying “Hi, P2!” in the in-game chat.

- In DSH, run `/p2 status` to check P2's status.
- Run `/p2 stop` to disconnect P2.
- To change the player name, stop P2, edit `minecraft.username` in `.p2/config.json`, then run `/p2 start` again with your server address and port.

## DSH tools

These tools become available in the DSH session that started P2. In that session, you can ask DSH in plain language to check P2's status or give it a task.

| Tool | Purpose |
|---|---|
| `p2_status` | Check the connection, controlling session, current task, and recent failures |
| `p2_body` | Start, stop, restart, or inspect the P2 body; any session may start it while inactive, but only the owner may control it once active |
| `p2_order` | Submit a task. Supports `go / place / dig / collect / equip / use / attack / check / container / craft / build / traverse / hold` |
| `p2_orders` | View active and queued tasks, and see why the queue is blocked |
| `p2_cancel` | Cancel a specified task or all queued tasks |
| `p2_report` | Read the latest summary of how a task went off plan or ended |
| `p2_events` | Read the event stream for troubleshooting |
| `p2_observe` | Inspect or count blocks, or query specific locations |
| `p2_entities` | Inspect entities and dropped items |
| `p2_preview_blueprint` | Check a blueprint's material requirements, conflicts, and unloaded positions |
| `p2_say` | Send a chat message as P2 |
| `p2_memory` | Save, retrieve, or delete memories |
| `p2_duty` | Start or stop an ongoing duty |
| `p2_policy` | Configure P2's combat, retreat, and self-care behavior |
| `p2_base_activity` | Set what P2 does while idle. Supports `idle / wandering / escort` |

For example, DSH can use `p2_observe` to find a nearby crafting table and `p2_order` to send P2 to the coordinates it found.

```text
p2_observe {mode:"find", only:["crafting_table"], radius:16}
p2_order {verb:"go", params:{x:48,y:64,z:30}}
```

An `accepted` response from `p2_order` confirms receipt. P2 reports back to the DSH session when the task finishes, gets blocked, or fails.

## `.p2` workspace

`/p2 start` creates any missing template files in the current session's project directory and keeps existing files.

```text
.p2/
  persona.md              # Personality settings. Changes take effect on the next turn.
  config.json             # Player settings, connection behavior, and automatic wakeups.
  memory/<world>/<character>.jsonl
  skills/<name>/SKILL.md   # Workspace skills. Changes are picked up automatically.
```

`.p2/` stores local state. Keep it out of version control.

## Plugin structure

```text
DSH plugin (bridge)
  └─ body subprocess (P2Mind)
       └─ provider (mineflayer) ── Minecraft server
```

DSH manages sessions, tools, and the plugin lifecycle. P2Mind runs tasks in-game, and mineflayer communicates with the Minecraft server.

## Documentation

- [Developer and design documentation (Chinese)](docs/README.md)
