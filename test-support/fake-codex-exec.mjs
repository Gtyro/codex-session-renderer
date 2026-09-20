const noTokens = process.argv.includes("--no-tokens");

process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "fake-thread-001" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn.started", thread_id: "fake-thread-001", turn_id: "fake-turn-001" })}\n`);
process.stdout.write(`${JSON.stringify({
  type: "item.completed",
  thread_id: "fake-thread-001",
  turn_id: "fake-turn-001",
  item: { id: "fake-command-001", type: "command_execution", status: "completed", command: "./tools/resolve-release-year --title Braid --compact" }
})}\n`);
process.stdout.write(`${JSON.stringify({
  type: "item.completed",
  thread_id: "fake-thread-001",
  turn_id: "fake-turn-001",
  item: { id: "fake-item-001", type: "agent_message", status: "completed", text: "Completed with evidence." }
})}\n`);
process.stdout.write(`${JSON.stringify({
  type: "turn.completed",
  thread_id: "fake-thread-001",
  turn_id: "fake-turn-001",
  ...(noTokens ? {} : { usage: { total_tokens: 720, input_tokens: 500, output_tokens: 220 } })
})}\n`);
