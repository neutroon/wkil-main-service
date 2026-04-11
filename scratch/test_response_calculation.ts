
function calculateResponseTimes(messages: any[]) {
  const userStartTimes = new Map<number, number>();
  const aiSamples: number[] = [];
  const humanSamples: number[] = [];

  for (const msg of messages) {
    const cid = msg.conversationId;
    if (msg.role === "user") {
      if (!userStartTimes.has(cid)) {
        userStartTimes.set(cid, msg.createdAt.getTime());
      }
    } else if (msg.role === "model") {
      const startTime = userStartTimes.get(cid);
      if (startTime) {
        const diffMinutes = Math.max(0, (msg.createdAt.getTime() - startTime) / (1000 * 60));

        if (msg.status === "SENT") {
          aiSamples.push(diffMinutes);
        } else if (msg.status === "EDITED_AND_SENT") {
          humanSamples.push(diffMinutes);
        }
        
        userStartTimes.delete(cid);
      }
    }
  }

  const aiAvg = aiSamples.length > 0 
    ? aiSamples.reduce((a, b) => a + b, 0) / aiSamples.length 
    : 0;
  
  const humanAvg = humanSamples.length > 0 
    ? humanSamples.reduce((a, b) => a + b, 0) / humanSamples.length 
    : 0;

  const totalSamples = [...aiSamples, ...humanSamples];
  const overallAvg = totalSamples.length > 0 
    ? totalSamples.reduce((a, b) => a + b, 0) / totalSamples.length 
    : 0;

  return { 
    aiAvg: parseFloat(aiAvg.toFixed(2)), 
    humanAvg: parseFloat(humanAvg.toFixed(2)), 
    overallAvg: parseFloat(overallAvg.toFixed(2)) 
  };
}

// Test Cases
const baseTime = Date.now();
const testMessages = [
  // Session 1: Simple AI response (5 mins)
  { conversationId: 1, role: "user", status: "SENT", createdAt: new Date(baseTime) },
  { conversationId: 1, role: "model", status: "SENT", createdAt: new Date(baseTime + 5 * 60 * 1000) },
  
  // Session 2: Multiple user messages, then Human response (10 mins from first user message)
  { conversationId: 2, role: "user", status: "SENT", createdAt: new Date(baseTime + 10 * 60 * 1000) },
  { conversationId: 2, role: "user", status: "SENT", createdAt: new Date(baseTime + 12 * 60 * 1000) },
  { conversationId: 2, role: "model", status: "EDITED_AND_SENT", createdAt: new Date(baseTime + 20 * 60 * 1000) },
  
  // Session 3: AI response (1 min)
  { conversationId: 3, role: "user", status: "SENT", createdAt: new Date(baseTime + 30 * 60 * 1000) },
  { conversationId: 3, role: "model", status: "SENT", createdAt: new Date(baseTime + 31 * 60 * 1000) }
];

const results = calculateResponseTimes(testMessages);
console.log("Calculation Results:", results);

// Expected:
// AI: (5 + 1) / 2 = 3.0
// Human: 10 / 1 = 10.0
// Overall: (5 + 10 + 1) / 3 = 5.33

if (results.aiAvg === 3.0 && results.humanAvg === 10.0 && results.overallAvg === 5.33) {
  console.log("✅ TEST PASSED: Accurate Analysis Confirmed.");
} else {
  console.log("❌ TEST FAILED: Logic discrepancy found.");
}
