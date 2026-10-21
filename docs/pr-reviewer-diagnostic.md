# OpenCode Agent Diagnostic Report

This file documents the runtime environment of the PR reviewer agent
for debugging purposes when reviews fail unexpectedly.

## Expected File Layout

The opencode CLI creates the following files during `opencode run`:

```
.opencode/
  config.json       # Contains provider URL, model settings
  state.json        # Session state including auth tokens
  sessions/         # Session history
```

The runner temp directory (`$RUNNER_TEMP`) contains:
```
pr-reviewer-events.jsonl    # All tool call events
pr-reviewer-response.md     # Final review output
```

## Verification Steps

To verify the agent environment is correctly configured:

1. Check that `.opencode/` exists and contains expected files
2. Verify the OPENCODE_API_KEY is set (should start with `oc_sk_`)
3. Confirm the model `opencode/muse-spark-1.3` is accessible

## Known Issues

- If the agent cannot read `.opencode/config.json`, it may be running
  in a restricted sandbox
- The EVENTS_FILE path varies by runner OS
