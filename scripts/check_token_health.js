const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const prisma = new PrismaClient();
const { decryptFacebookSecret } = require('../utils/tokenCrypto');

async function main() {
  const pageId = '113571781631445';
  const page = await prisma.facebookPage.findFirst({
    where: { pageId }
  });

  if (!page) {
    console.error('Page not found in DB');
    return;
  }

  const token = decryptFacebookSecret(page.pageAccessToken);
  const fbApi = process.env.FB_API_URL || 'https://graph.facebook.com/v21.0';

  try {
    console.log(`Checking permissions for Page: ${page.pageName} (${pageId})`);
    const resp = await axios.get(`${fbApi}/me/permissions?access_token=${token}`);
    console.log('--- PERMISSIONS ---');
    console.dir(resp.data.data, { depth: null });

    const tasksResp = await axios.get(`${fbApi}/me?fields=tasks&access_token=${token}`);
    console.log('--- TASKS ---');
    console.dir(tasksResp.data, { depth: null });

  } catch (err) {
    console.error('API Call failed:', err.response?.data || err.message);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
