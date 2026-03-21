import generateContent from "../config/gemini";

async function discoverStrategicLinks(baseUrl: string, pageContent: string) {
  const prompt = `
    أنت مساعد ذكي متخصص في تحليل هيكل المواقع الإلكترونية (Web Navigation Expert).
    مهمتك هي قراءة المحتوى المستخرج من الصفحة الرئيسية لموقع العميل، واستخراج أهم الروابط (URLs) التي تحتوي على معلومات تفصيلية نحتاجها لبناء "هوية البيزنس".

    نحن نبحث تحديداً عن الروابط التي تقود إلى صفحات:
    - المنتجات أو الخدمات (Products / Services)
    - معلومات عن الشركة (About Us)
    - معلومات التواصل (Contact Us)
    - الأسئلة الشائعة (FAQs)
    - سياسات العمل (Policies / Terms)

    ⚠️ قواعد صارمة (CRITICAL):
    1. استخرج من 3 إلى 5 روابط فقط كحد أقصى (الأكثر أهمية لما نبحث عنه).
    2. يجب أن تستخرج الروابط الموجودة فعلياً داخل النص المرفق.
    3. [هام جداً] إذا كان الرابط المستخرج فرعياً (Relative URL) مثل "/about"، يجب عليك دمجه مع الرابط الأساسي للموقع ليصبح رابطاً كاملاً (Absolute URL).
    4. تجاهل تماماً روابط السوشيال ميديا، روابط تسجيل الدخول، سلة المشتريات، والروابط الخارجية.

    الهيكلة المطلوبة للمخرجات (JSON Schema):
    {
      "urls": ["رابط كامل 1", "رابط كامل 2", "رابط كامل 3"]
    }

    --- الرابط الأساسي للموقع (Base URL) ---
    ${baseUrl}

    --- المحتوى المستخرج من الصفحة الرئيسية ---
    ${pageContent}
  `;

  try {
    const result = await generateContent(prompt, "application/json");

    if (!result) {
      throw new Error("Failed to generate content with Gemini");
    }
    const parsedData = JSON.parse(result);

    return parsedData.urls || [];
  } catch (error) {
    console.error("Error discovering links with Gemini:", error);
    return [];
  }
}

async function extractBusinessIdentity(markdown: string) {
  const prompt = `
    أنت خبير استراتيجي في بناء العلامات التجارية وتحليل الأعمال.
    مهمتك هي تحليل نص مستخرج من موقع إلكتروني (أو PDF) لعميل، وتحويله إلى بيانات منظمة تمثل "هوية البيزنس" لبناء مساعد ذكي (AI Agent) يمثله.

    قواعد عامة:
    1. لا تخترع أي معلومات غير موجودة في النص إطلاقاً (No Hallucination).
    2. تجاهل نصوص القوائم العشوائية (Navigation menus) وحقوق النشر والتذييل (Footers).
    3. إذا لم تجد المعلومة، اكتب "غير محدد" فقط.
    4. التزم باللغة العربية.
    5. استخرج البيانات بناءً على صلب المحتوى الفعلي للموقع.

    الهيكلة المطلوبة للمخرجات (JSON Schema):
    {
      "business_name": "اسم البيزنس أو البراند (إن وُجد)",
      "brand_identity": "وصف مختصر لما يفعله البيزنس (max 2 جملة)",
      "target_audience": "من هم العملاء المستهدفون؟ (وصف مختصر)",
      "voice_and_tone": "صيغة تحدث البوت المقترحة (مثال: احترافي وودود، أو شبابي ومرح)",
      "products_services": ["الفئة أو الخدمة 1", "الفئة أو الخدمة 2"],
      "expected_user_intents": ["توقع 3 إلى 5 نوايا/طلبات شائعة من عملاء هذا البيزنس، مثال: الاستفسار عن الأسعار، حجز موعد، تفاصيل الشحن"],
      "contact_and_hours": {
        "phone_numbers": ["رقم 1", "رقم 2"],
        "working_hours": "مواعيد العمل أو غير محدد",
        "address": "العنوان الفعلي أو غير محدد"
      },
      "core_policies": "أي معلومات متوفرة عن الشحن، التوصيل، الاسترجاع، أو طرق الدفع (أو غير محدد)",
      "faqs": [
        {
          "question": "سؤال متوقع بناءً على النص",
          "answer": "إجابة مختصرة ووافية"
        }
      ]
    }

    الآن، قم بتحليل النص التالي:
    ${markdown}
  `;

  try {
    const result = await generateContent(prompt, "application/json");

    if (!result) {
      throw new Error("Failed to generate content with Gemini");
    }
    const parsedData = JSON.parse(result);

    return parsedData;
  } catch (error) {
    console.error("Error analyzing markdown with Gemini:", error);
    throw new Error("Failed to extract business identity.");
  }
}

export { discoverStrategicLinks, extractBusinessIdentity };
