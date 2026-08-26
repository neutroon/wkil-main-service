def chunk_business_profile(profile: dict) -> list[dict]:
    chunks = []
    if profile.get("name"):
        chunks.append({"chunk_type": "identity", "content": f"Business: {profile['name']}"})
    for faq in profile.get("faqs", []):
        chunks.append({"chunk_type": "faq",
                       "content": f"Q: {faq.get('question')}\nA: {faq.get('answer')}"})
    for ks in profile.get("knowledgeSections", []):
        chunks.append({"chunk_type": "knowledge",
                       "content": f"{ks.get('title')}: {ks.get('body')}"})
    return chunks
