import { AgentClient } from "../src/modules/ai-agent/client/agent.client";

const SAMPLES: Array<Record<string, unknown>> = [
  { business_profile_id: 1, user_id: 2, messages: [{ role: "user", content: "What are your hours?" }], stage: "fast" },
  { business_profile_id: 1, user_id: 2, messages: [{ role: "user", content: "Book me an appointment" }], stage: "fast" },
];

async function main() {
  if (!AgentClient.enabled()) {
    console.error("Set USE_AGENT_SERVICE=true and LANGGRAPH_API_URL/LANGGRAPH_API_KEY first.");
    process.exit(2);
  }
  let ok = 0, fail = 0;
  for (const [i, input] of SAMPLES.entries()) {
    try {
      const r = await AgentClient.runAgent(input, { stream: false });
      const status = (r as any)?.status ?? "unknown";
      console.log(`replay[${i}] status=${status}`);
      ok++;
    } catch (e: any) {
      console.error(`replay[${i}] failed: ${e?.message}`);
      fail++;
    }
  }
  console.log(`done: ${ok} ok, ${fail} fail`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
