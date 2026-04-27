import axios from "axios";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const WABA_ID = "902403589466601";
const SYSTEM_TOKEN = process.env.FB_SYSTEM_USER_ACCESS_TOKEN;

async function verifySubscription() {
  if (!SYSTEM_TOKEN) {
    console.error("WHATSAPP_SYSTEM_USER_TOKEN not found in .env");
    return;
  }

  try {
    console.log(`Checking subscribed apps for WABA: ${WABA_ID}...`);
    const response = await axios.get(
      `https://graph.facebook.com/v21.0/${WABA_ID}/subscribed_apps`,
      {
        headers: {
          Authorization: `Bearer ${SYSTEM_TOKEN}`,
        },
      }
    );

    console.log("Meta API Response (Subscribed Apps):");
    console.log(JSON.stringify(response.data, null, 2));

    const apps = response.data.data || [];
    if (apps.length === 0) {
      console.log("\n✅ SUCCESS: No apps are currently subscribed to this WABA. It is fully disconnected.");
    } else {
      console.log(`\n⚠️ WARNING: There are still ${apps.length} app(s) subscribed to this WABA.`);
      apps.forEach((app: any) => {
        console.log(`- App Name: ${app.name}, ID: ${app.id}`);
      });
    }
  } catch (error: any) {
    console.error("Error checking subscription:", error.response?.data || error.message);
  }
}

verifySubscription();
