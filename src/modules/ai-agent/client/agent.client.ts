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
  private static readonly GRAPHS = {
    copilot: "agent",
    customer: "customer_agent",
    ragIngest: "rag_ingest",
  } as const;

  private static async run(graph: string, input: Record<string, unknown>, opts: { stream?: boolean } = {}) {
    const client = this.client();
    const thread = await client.threads.create();
    return client.runs.create(thread.thread_id, graph, { input, stream: opts.stream ?? false } as any);
  }

  static runCopilot(input: Record<string, unknown>, opts: { stream?: boolean } = {}) {
    return this.run(this.GRAPHS.copilot, input, opts);
  }

  // The capability draft lives in the run result's final state; the SDK's
  // `Run` typing doesn't reflect that, so callers consume it as a record.
  static async runContentGeneration(kind: string, context: Record<string, unknown>): Promise<any> {
    const result = await this.run(this.GRAPHS.copilot, { content_generation: { kind, context } }, { stream: false });
    return result;
  }

  static runCustomerAgent(input: Record<string, unknown>, opts: { stream?: boolean } = {}) {
    return this.run(this.GRAPHS.customer, input, opts);
  }
  static async ingestRag(payload: Record<string, unknown>) {
    const client = this.client();
    const thread = await client.threads.create();
    return client.runs.create(thread.thread_id, "rag_ingest", { input: payload } as any);
  }
}
