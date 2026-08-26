import { Client } from "@langchain/langgraph-sdk";

const ENABLED = process.env.USE_AGENT_SERVICE === "true";
const API_URL = process.env.LANGGRAPH_API_URL ?? "http://localhost:8123";

export class AgentClient {
  static enabled() { return ENABLED; }
  private static client(): Client {
    return new Client({ apiUrl: API_URL, apiKey: process.env.LANGGRAPH_API_KEY ?? "" });
  }
  static async createThread() {
    return this.client().threads.create();
  }
  static async runAgent(input: Record<string, unknown>, opts: { stream?: boolean } = {}) {
    const client = this.client();
    const thread = await client.threads.create();
    const run = await client.runs.create(thread.thread_id, "agent", {
      input,
      stream: opts.stream ?? false,
    } as any);
    return run;
  }
  static async ingestRag(payload: Record<string, unknown>) {
    const client = this.client();
    const thread = await client.threads.create();
    return client.runs.create(thread.thread_id, "rag_ingest", { input: payload } as any);
  }
}
