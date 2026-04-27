import axios from "axios";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const WABA_ID = "902403589466601";
const SYSTEM_TOKEN = process.env.FB_SYSTEM_USER_ACCESS_TOKEN;

async function resubscribe() {
  if (!SYSTEM_TOKEN) {
    console.error("FB_SYSTEM_USER_ACCESS_TOKEN not found in .env");
    return;
  }

  try {
    console.log(`Resubscribing App to WABA: ${WABA_ID}...`);
    
    // Step 1: POST to subscribed_apps to enable webhooks
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${WABA_ID}/subscribed_apps`,
      {},
      {
        headers: {
          Authorization: `Bearer ${SYSTEM_TOKEN}`,
        },
      }
    );

    if (response.data.success) {
      console.log("✅ SUCCESS: App successfully re-subscribed to WABA webhooks.");
      console.log("Response:", JSON.stringify(response.data, null, 2));
    } else {
      console.log("⚠️ WARNING: API call returned success:false.");
      console.log("Response:", response.data);
    }

  } catch (error: any) {
    console.error("❌ ERROR re-subscribing:", error.response?.data || error.message);
  }
}

resubscribe();
