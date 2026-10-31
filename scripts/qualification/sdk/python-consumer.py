import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile

from omp_rpc import RpcClient, RpcCommandError, host_tool

checkout = Path(os.environ["CF_QUAL_CHECKOUT"])
agent_dir = Path(tempfile.mkdtemp(prefix="python-agent-", dir=os.environ["CF_QUAL_SDK_RUNTIME"]))
provider = subprocess.Popen(
    [os.environ["CF_QUAL_REAL_BUN"], "packages/coding-agent/test/rpc-wire/fake-openai-server.ts", str(agent_dir)],
    cwd=checkout,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
    start_new_session=True,
)
client = None
calls = []
observed = {}


def echo_host(args, context):
    calls.append(args)
    context.send_update("echoing")
    return "host:" + args["message"]


try:
    with selectors.DefaultSelector() as selector:
        selector.register(provider.stdout, selectors.EVENT_READ)
        assert selector.select(timeout=30), "scripted provider did not become ready"
    banner = provider.stdout.readline().strip()
    assert banner.startswith("READY "), banner
    client = RpcClient(
        command=[
            os.environ["CF_QUAL_SDK_LAUNCHER"],
            "packages/coding-agent/src/cli.ts",
            "--mode", "rpc", "--no-session", "--no-skills", "--no-rules", "--no-title",
            "--model", "fake/fake-model",
        ],
        cwd=checkout,
        env={"PI_CODING_AGENT_DIR": str(agent_dir)},
        custom_tools=(host_tool(
            name="echo_host",
            description="Return a synthetic message from the Python host",
            parameters={
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
                "additionalProperties": False,
            },
            execute=echo_host,
            load_mode="essential",
        ),),
    )
    client.start()
    created = client.goal("create", objective="Python SDK qualification", token_budget=5000)
    assert created.goal is not None and created.goal.status == "active" and created.goal.token_budget == 5000
    paused = client.goal("pause")
    assert paused.goal is not None and paused.goal.status == "paused"
    client.goal("drop")
    try:
        client.get_entries(since="no-such-qualification-entry")
    except RpcCommandError as error:
        assert error.code == "unknown_since", error
    else:
        raise AssertionError("get_entries accepted an unknown entry")
    turn = client.prompt_and_wait("say hi", timeout=60)
    assert turn.require_assistant_text() == "pong"
    assert turn.result is not None and turn.result.status == "completed"
    tool_turn = client.prompt_and_wait("please use echo_host", timeout=60)
    assert tool_turn.require_assistant_text() == "tool said: host:hello"
    assert calls == [{"message": "hello"}], calls
    updates = [event for event in tool_turn.events if event.type == "tool_execution_update"]
    ends = [event for event in tool_turn.events if event.type == "tool_execution_end"]
    assert any(event.tool_name == "echo_host" and event.partial_result["content"][0]["text"] == "echoing" for event in updates)
    assert any(event.tool_name == "echo_host" and event.result["content"][0]["text"] == "host:hello" and not event.is_error for event in ends)
    assert client.protocol_errors == (), client.protocol_errors
    assert client.listener_errors == (), client.listener_errors
    observed = {
        "language": "python",
        "mode": os.environ["CF_QUAL_MODE"],
        "assistant": turn.require_assistant_text(),
        "toolAssistant": tool_turn.require_assistant_text(),
        "hostCalls": calls,
        "goalTransitions": [created.goal.status, paused.goal.status],
        "unknownEntryCode": "unknown_since",
        "promptStatus": turn.result.status,
    }
finally:
    try:
        if client is not None:
            assert client.stop(), "Python RPC process group survived stop"
            assert client.survivor_pids == (), client.survivor_pids
    finally:
        if provider.stdin is not None:
            provider.stdin.close()
        try:
            code = provider.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(provider.pid, signal.SIGKILL)
            provider.wait()
            raise
        assert code == 0, f"scripted provider exited {code}"

observed["workersClosed"] = True
print(json.dumps(observed, sort_keys=True), flush=True)
