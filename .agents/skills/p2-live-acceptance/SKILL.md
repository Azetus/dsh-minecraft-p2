---
name: p2-live-acceptance
description: Use this skill as the outer development agent for this repository when dispatching Minecraft LAN acceptance tests in natural language through an isolated p2-dev DSH session, verifying in-game evidence, or closing out a run.
---

# P2 live acceptance testing

Run development commands from the repository root. You manage the test environment, dispatch tasks in natural language, verify evidence, and clean up. The DSH owner session operates P2_Bot.

For a skill-loading check, invoke `$p2-live-acceptance` in Codex or include `/p2-live-acceptance` in a DSH user message. Finish once the host loads the skill and you can read back its instructions. This check requires no LAN connection, game commands, or running P2 body.

## Identify the inputs for this run

Get the game version, LAN address, and current port from the user or the running game. Reuse an available LAN world. Otherwise, ask the player to open the world in the requested version and choose **Open to LAN**. Mineflayer joins as a client. Confirm the test character, the identities of online players, the test objective, which world changes the user permits, and what state to restore afterward. Enabling commands when opening the world only establishes that commands are available.

Identify the session to continue from the isolated DSH session list, its working directory, and recent test records. When the user asks to resume a test, reuse that session ID. For a first run, you can create a test session and record the returned ID. The session's working directory determines which `.p2/config.json` it uses and may differ from both the repository root and the default test workspace.

## Reuse the environment and connect

- Check that `.dev-home/run` under the repository root, its `profiles/p2-dev` directory, and the expected session still exist. Pass `--reuse` or `--refresh` explicitly to preserve the environment. Running `dev.mjs` without either option rebuilds it by default.
- If the plugin has changed, run `npm run check`. From the original owner session, stop any active body and confirm it is `inactive` before shutting down the previous test host for this run. Run `node scripts/dev.mjs --refresh --no-start --keep` from the repository root. Confirm that installation and the profile check succeeded, and record the SHA-256 of the current tarball. After startup, verify that the active body and provider entry points match this build. File hashes can distinguish builds when reinstalling the same version.
- To test the installed plugin, reuse the running isolated service. If it needs to be started, run `node scripts/dev.mjs --reuse --keep`. Read the local Web address and dynamically assigned port from this launch's output. Use the Web token and login cookie only for local requests. Keep them out of prompts, evidence files, and reports.
- In the selected session, ask DSH in natural language to verify the character's `version` and `username` and connect to this run's LAN world. Ask it to read back the target, connection status, `bodyEpoch`, and owner from `p2_status`. If another owner holds the character, resolve ownership before proceeding. Wait for confirmation that the body is connected to the game server.

## Dispatch a task and verify the outcome

Send the task in natural language through the DSH Web session. For automation, consult `scripts/dev-api-smoke.mjs` for local authentication and the RPC wrapper. Running that script creates a session and starts and stops a body. Use its `rpc(method, args)` wrapper to send the task to the selected session.

```js
await rpc('session/prompt', {
  request: {
    sessionId,
    requestId: crypto.randomUUID(),
    mode: 'queue',
    content: [{ type: 'text', text: task }],
  },
})
```

An `accepted` receipt confirms that the prompt was queued. Follow the session responses and order results, record the `orderId`, and query that ID while waiting to avoid submitting the order twice.

Specify the objective, permitted setup, behavior to observe, and expected terminal state. Leave the choice of actions within the task to P2. For example, “Attack the designated target with an unloaded crossbow, ordinary arrows, and a sword. Ranged attacks are allowed. Record the inventory arrow count, the crossbow's loaded projectiles, and the arrows actually fired. Report once the order ends on its own.” When testing automatic sword switching, let P2 choose when to switch.

Match `p2_report`, `order.result`, and in-game observations to the same `orderId`. Distinguish prompt acceptance, job completion, and natural order completion. A ranged attempt can include an interrupted draw or reload. To check for an extra shot, record inventory changes, projectiles loaded in the crossbow, observed arrow entities, and the source of each hit separately. If needed, spectate with a separate identity and record how distances were sampled. Mark outcomes as unconfirmed when evidence is insufficient. Save raw receipts and observations under the local `.live/runs/` directory after removing credentials.

## Close out the run

While still connected, remove entities created for the test, restore any world settings changed for the run, and read back their values. If the run ends unexpectedly, report anything that still needs restoration.

If the user wants to continue the same run, keep the owner session and connection active. At the end of the run, issue `/p2 stop` from the original owner session and confirm `inactive` with `/p2 status`. Disconnect the test spectator, stop this run's isolated DSH host, and verify that its listening port has closed. Preserve `.dev-home`, the `p2-dev` profile, and the session. Check that the session history is still readable. In the final report, distinguish software checks, live observations, and anything that remains unverified.
