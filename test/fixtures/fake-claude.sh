#!/bin/sh
# A stand-in for `claude -p` in noid's Claude Code provider tests: it answers --version as Claude Code does, and a
# request (one stream-json message on stdin) with stream-json lines ending in a result. The first turn calls bash; once
# a tool result is in the conversation, it answers with the result's last line. "slow" takes 30 s (to be stopped);
# "fail please" fails; "as your own" calls Bash as its own tool, as Claude does, hears Claude Code refuse it, and gives
# up only 30 s later (by then the call should have been taken). It records its arguments, folder, environment, and input for the test to read.
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
input=$(cat)
dir=${FAKE_CLAUDE_DIR:-/tmp}
n=$$
printf '%s\n' "$@" > "$dir/args.txt"
pwd > "$dir/cwd.txt"
env > "$dir/env.txt"
printf '%s' "$input" > "$dir/input.txt"
cp "$(printf '%s\n' "$@" | sed -n '/--system-prompt-file/{n;p}')" "$dir/system.txt" 2>/dev/null
echo '{"type":"system","subtype":"init"}'
case "$input" in
  *"slow"*) sleep 30 ;;
  *"fail please"*)
    echo '{"type":"result","is_error":true,"result":"API Error: 429 Claude AI usage limit reached"}'; exit 1 ;;
  *"Tool result for call"*)
    last=$(printf '%s' "$input" | sed 's/.*from-bash.*/from-bash/' | tail -c 200)
    echo '{"type":"result","is_error":false,"structured_output":{"text":"bash said: from-bash","tool_calls":[]}}' ;;
  *"as your own"*)
    echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Checking."}]}}'
    echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo from-bash"}}]}}'
    echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"<tool_use_error>No such tool available: Bash</tool_use_error>"}]}}'
    sleep 30
    echo '{"type":"result","is_error":false,"structured_output":{"text":"Bash is not available.","tool_calls":[]}}' ;;
  *)
    echo '{"type":"result","is_error":false,"structured_output":{"text":"Running it.","tool_calls":[{"name":"bash","arguments":"{\"command\":\"echo from-bash\"}"}]}}' ;;
esac
