import { mapFacebookGraphError } from "../utils/facebookGraphError";

// Mock Logger
const logger = {
    warn: (msg: string, meta: any) => console.warn(`[WARN] ${msg}`, meta),
    error: (msg: string, meta: any) => console.error(`[ERROR] ${msg}`, meta)
};

// Mock mapFacebookGraphError behavior (simplified for testing)
function mockMapError(error: any) {
    if (error.response?.data?.error?.code === 100) {
        return { code: 100, message: "Object does not exist", status: 400 };
    }
    return { message: "Unknown error" };
}

// THE LOGIC WE WANT TO TEST (from facebook.service.ts)
async function testGetFacebookUserProfile(psid: string, shouldFailWith100: boolean) {
    try {
        const cleanPsid = psid.trim();
        console.log(`Fetching profile for: "${cleanPsid}"`);
        
        if (shouldFailWith100) {
            throw { response: { status: 400, data: { error: { code: 100, message: "Unsupported get request" } } } };
        }
        
        return { name: "Test User" };
    } catch (error: any) {
        const mapped = mockMapError(error);
        
        if (mapped.code === 100 || (mapped.status && mapped.status >= 400 && mapped.status < 500)) {
            logger.warn("facebook.user_profile.fetch_skipped", { psid, ...mapped });
        } else {
            logger.error("facebook.user_profile.fetch_failed", mapped);
        }
        return null;
    }
}

// THE LOGIC WE WANT TO TEST (from metaProcessor.service.ts)
async function testProcessorIdentityLogic(job: any, profileResult: any) {
    let customerNameSet: string | undefined;
    
    // Simulate the logic in processMetaMessage
    try {
        const profile: any = profileResult;
        
        if (profile && profile.name && String(profile.name).toLowerCase() !== "null") {
            customerNameSet = profile.name;
        } else if (job.senderName) {
            customerNameSet = job.senderName;
        }
    } catch (e: any) {
        customerNameSet = job.senderName || "Guest Customer";
    } finally {
        if (!customerNameSet || String(customerNameSet).toLowerCase() === "null") {
            customerNameSet = job.senderName || "Guest Customer";
        }
    }
    
    return customerNameSet;
}

async function runTests() {
    console.log("--- TEST 1: PSID with whitespace ---");
    await testGetFacebookUserProfile("  12345  ", false);

    console.log("\n--- TEST 2: Facebook returns Code 100 (Object does not exist) ---");
    const result2 = await testGetFacebookUserProfile("26699675612998789", true);
    console.log("Result should be null:", result2 === null);

    console.log("\n--- TEST 3: Fallback to job.senderName when profile is null ---");
    const job3 = { senderName: "Original Sender" };
    const name3 = await testProcessorIdentityLogic(job3, null);
    console.log("Result should be 'Original Sender':", name3 === "Original Sender" ? "PASS" : "FAIL");

    console.log("\n--- TEST 4: Fallback to job.senderName when profile is literal 'null' ---");
    const job4 = { senderName: "Original Sender" };
    const name4 = await testProcessorIdentityLogic(job4, { name: "null" });
    console.log("Result should be 'Original Sender':", name4 === "Original Sender" ? "PASS" : "FAIL");

    console.log("\n--- TEST 5: Absolute fallback to 'Guest Customer' ---");
    const job5 = { };
    const name5 = await testProcessorIdentityLogic(job5, null);
    console.log("Result should be 'Guest Customer':", name5 === "Guest Customer" ? "PASS" : "FAIL");
}

runTests();
