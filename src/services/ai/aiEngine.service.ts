import { Tool } from "@google/genai";
import { logger } from "../../utils/logger";
import { genAI, MESSENGER_SAFETY_SETTINGS } from "../../config/gemini";
import { pushLeadToCrm } from "../crm/crm.service";
import { executeExternalQuery } from "../external/externalData.service";

export async function runAIEngineLoop(params: {
  systemInstruction: string;
  historyTurns: { role: "user" | "model"; text?: string; parts?: any[] }[];
  customerMessage: string;
  tools?: Tool[];
  businessProfileId: number;
  customerPhone?: string; // fallback
}): Promise<string> {
  const contents = [
    ...params.historyTurns.map((t) => ({
      role: t.role,
      parts: t.parts ? t.parts : [{ text: t.text }],
    })),
    {
      role: "user" as const,
      parts: [{ text: params.customerMessage }],
    },
  ];

  let turnCount = 0;
  const MAX_TURNS = 3;

  while (turnCount < MAX_TURNS) {
    turnCount++;
    const response = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
      config: {
        systemInstruction: params.systemInstruction,
        temperature: 0.35,
        maxOutputTokens: 512,
        safetySettings: MESSENGER_SAFETY_SETTINGS,
        tools: params.tools,
      },
    });

    const candidate = (response as any).candidates?.[0];
    if (!candidate) throw new Error("No candidate from Gemini");

    const responseParts = candidate.content?.parts || [];
    
    // Safely extract text parts
    let responseText = responseParts
      .filter((p: any) => p.text)
      .map((p: any) => p.text)
      .join("")
      .trim();

    const functionCalls = response.functionCalls || [];

    // If there's no function call, we are done
    if (functionCalls.length === 0) {
      if (!responseText) throw new Error("No reply text and no function call generated");
      return responseText;
    }

    // Add the model's turn (with its function calling request) to the contents history
    contents.push({
      role: "model",
      parts: responseParts,
    });

    // Execute all requested functions
    const functionResponses: any[] = [];
    for (const call of functionCalls) {
      if (!call.name) continue; // Skip empty function calls to fix linter warning
      
      const args = call.args as any;

      if (call.name === "capture_lead") {
        await pushLeadToCrm(params.businessProfileId, {
          ...args,
          phone: args.phone || params.customerPhone,
        });
        responseText = `Thanks ${args.name ? args.name.split(" ")[0] : ""}! I've securely passed your details to our team. Someone will be in touch with you shortly.`;
        // Since we consider lead capturing a terminal action that ends the loop successfully:
        return responseText;
      } 
      
      if (call.name.startsWith("query_external_api_")) {
        const sourceId = parseInt(call.name.split("_").pop() || "0", 10);
        logger.info("ai.executing_external_tool", { sourceId, args });
        const result = await executeExternalQuery(sourceId, args);
        
        functionResponses.push({
          functionResponse: {
            name: call.name,
            response: result,
          }
        });
      }
    }

    // Append function results back to the user context so Gemini sees the data
    if (functionResponses.length > 0) {
      contents.push({
        role: "user",
        parts: functionResponses,
      });
    }
  }

  throw new Error("Exceeded max AI tool turns without Final Answer");
}
