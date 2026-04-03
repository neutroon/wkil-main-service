import { Tool } from "@google/genai";
import { logger } from "../../utils/logger";
import { genAI, MESSENGER_SAFETY_SETTINGS } from "../../config/gemini";
import { pushLeadToCrm } from "../crm/crm.service";
import { executeExternalQuery } from "../external/externalData.service";

function hasDeferralFiller(text: string): boolean {
  return /(?:let me|please wait|one moment|i(?:'|’)ll check|i will check|allow me to check|جار[يى]|لحظة|ثواني|اسمح لي)/i.test(
    text,
  );
}

function hasConfirmationClaim(text: string): boolean {
  return /(?:confirmed|confirmation|successfully confirmed|تم\s*التأكيد|مؤكد|اكتمل|ناجح)/i.test(
    text,
  );
}

function looksEmptyResult(data: unknown): boolean {
  if (data == null) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === "object") return Object.keys(data as Record<string, unknown>).length === 0;
  return false;
}

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
  let lastExternalQueryFailed = false;

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

      // Prevent "I'll check" dead-ends by forcing one more turn.
      if (hasDeferralFiller(responseText) && turnCount < MAX_TURNS) {
        contents.push({
          role: "user",
          parts: [
            {
              text:
                "Do not ask the user to wait. Either execute the required tool now and then answer, or provide a direct final answer based on available data.",
            },
          ],
        });
        continue;
      }

      // Prevent unsupported "confirmed" claims when external lookup failed.
      if (lastExternalQueryFailed && hasConfirmationClaim(responseText)) {
        return "I could not confirm that from the latest system data. Please verify the order number and share it again exactly as provided.";
      }

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
        const crmResult = await pushLeadToCrm(params.businessProfileId, {
          ...args,
          phone: args.phone || params.customerPhone,
        });
        
        if (crmResult.success) {
          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { 
                success: true, 
                message: "Lead successfully saved to CRM. You must now thank the user politely according to your persona and tell them the team will be in touch shortly." 
              },
            }
          });
        } else {
          logger.warn("ai.crm_validation_kickback", { error: crmResult.error });
          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { 
                success: false, 
                error: `CRM Webhook rejected the data. Reason: ${crmResult.error}. You MUST inform the user what was invalid (e.g. phone number format) and politely ask them to correct it. DO NOT thank them.` 
              },
            }
          });
        }
      } else if (call.name.startsWith("query_external_api_")) {
        const sourceId = parseInt(call.name.split("_").pop() || "0", 10);
        logger.info("ai.executing_external_tool", { sourceId, args });
        const result = await executeExternalQuery(sourceId, args);
        lastExternalQueryFailed = !result?.success || looksEmptyResult(result?.data);
        
        functionResponses.push({
          functionResponse: {
            name: call.name,
            response: result?.success
              ? result
              : {
                  ...result,
                  instruction:
                    "External data lookup failed or returned no usable result. You MUST NOT claim the order is confirmed/completed. Politely explain what is missing or invalid and ask the user to re-send the exact required value.",
                },
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
