import { Prisma } from "@prisma/client";

export const businessProfileSummarySelect = {
  id: true,
  userId: true,
  name: true,
  handoffEnabled: true,
  voice: true,
  tone: true,
  expectedUserIntents: true,
  corePolicies: true,
  customerDetailsInstructions: true,
  customerMemoryFields: true,
  aiBehaviorInstructions: true,
  followUpEnabled: true,
  followUpMode: true,
  followUpDelays: true,
  followUpInstructions: true,
  brandLogoUrl: true,
  brandPrimaryColor: true,
  brandSecondaryColor: true,
  brandAccentColor: true,
  visualAesthetic: true,
  artStyle: true,
  brandKitCompleted: true,
  monthlyTokensUsed: true,
  monthlyCreditsUsed: true,
  createdAt: true,
  updatedAt: true,
  knowledgeDocuments: { select: { id: true, kind: true, title: true, content: true, updatedAt: true } },
  facebookPages: {
    select: {
      id: true,
      pageId: true,
      pageName: true,
      category: true,
      pictureUrl: true,
      followersCount: true,
      isActive: true,
      businessProfileId: true,
    },
  },
  whatsAppAccounts: {
    select: {
      id: true,
      phoneNumberId: true,
      displayPhoneNumber: true,
      wabaId: true,
      isActive: true,
      businessProfileId: true,
    },
  },
} satisfies Prisma.BusinessProfileSelect;

export const businessProfileWithOwnerSelect = {
  ...businessProfileSummarySelect,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      plan: true,
      isActive: true,
    },
  },
} satisfies Prisma.BusinessProfileSelect;
