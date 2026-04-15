import { Request, Response } from "express";
import prisma from "../config/prisma";
import {
  ingestBusinessProfile,
  partialReIngestBusinessProfile,
  retrieveRelevantChunks,
} from "../rag/rag.service";

interface Faq {
  id?: number;
  question: string;
  answer: string;
}

interface KnowledgeSection {
  id?: number;
  title: string;
  content: string;
}

interface BusinessProfileBody {
  name: string;
  identity: string;
  targetAudience: string;
  voice: string;
  tone: string;
  productsServices: string[];
  expectedUserIntents: string[];
  corePolicies?: string;
  phoneNumbers: string[];
  workingHours?: string;
  address?: string;
  faqs?: Faq[];
  knowledgeSections?: KnowledgeSection[];
  leadCaptureInstructions?: string;
}

export const createBusinessProfile = async (req: Request, res: Response) => {
  try {
    const {
      name,
      identity,
      targetAudience,
      voice,
      tone,
      productsServices,
      expectedUserIntents,
      corePolicies,
      phoneNumbers,
      workingHours,
      address,
      faqs,
      knowledgeSections,
      leadCaptureInstructions,
    }: BusinessProfileBody = req.body;

    const userId = (req as any).user.id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const businessProfile = await prisma.businessProfile.create({
      data: {
        userId,
        name,
        identity,
        targetAudience,
        voice,
        tone,
        productsServices,
        expectedUserIntents,
        corePolicies,
        phoneNumbers,
        workingHours,
        address,
        leadCaptureInstructions,
        ...(faqs &&
          faqs.length > 0 && {
            faqs: {
              create: faqs.map((faq) => ({
                question: faq.question,
                answer: faq.answer,
              })),
            },
          }),
        ...(knowledgeSections &&
          knowledgeSections.length > 0 && {
            knowledgeSections: {
              create: knowledgeSections.map((ks) => ({
                title: ks.title,
                content: ks.content,
              })),
            },
          }),
      },
      include: {
        faqs: true,
        knowledgeSections: true,
      },
    });

    // mark user as having a business profile
    await prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        isBusinessProfileCreated: true,
      },
    });

    // trigger full ingestion
    await ingestBusinessProfile(businessProfile.id);

    const formattedProfile = {
      ...businessProfile,
      isConnectedToMeta: false,
      socialId: null,
    };

    return res.status(201).json({
      message: "Business profile created successfully",
      businessProfile: formattedProfile,
    });
  } catch (error) {
    console.error("Error creating business profile:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const getBusinessProfiles = async (req: Request, res: Response) => {
  try {
    const userId: number = (req as any).user.id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Find all profiles belonging to this user
    const businessProfiles = await prisma.businessProfile.findMany({
      where: {
        userId,
      },
      include: {
        faqs: true,
        facebookPages: {
          select: {
            pageId: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // const formattedProfiles = businessProfiles.map((profile) => {
    //   const { facebookPages, ...rest } = profile;
    //   return {
    //     ...rest,
    //     isConnectedToMeta: facebookPages.length > 0,
    //     socialId: facebookPages.length > 0 ? facebookPages[0].pageId : null,
    //   };
    // });

    return res.status(200).json({
      message: "Business profiles fetched successfully",
      businessProfiles,
    });
  } catch (error) {
    console.error("Error fetching business profile:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const updateBusinessProfile = async (req: Request, res: Response) => {
  try {
    const userId: number = (req as any).user.id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const profileId = parseInt(req.params.id);

    if (isNaN(profileId)) {
      return res.status(400).json({ message: "Invalid profile id" });
    }

    const {
      name,
      identity,
      targetAudience,
      voice,
      tone,
      productsServices,
      expectedUserIntents,
      corePolicies,
      phoneNumbers,
      workingHours,
      address,
      faqs,
      knowledgeSections,
      leadCaptureInstructions,
    }: BusinessProfileBody = req.body;

    // Verify the profile exists AND belongs to this user
    const existing = await prisma.businessProfile.findFirst({
      where: { id: profileId, userId },
    });

    if (!existing) {
      return res.status(404).json({ message: "Business profile not found" });
    }

    const businessProfile = await prisma.businessProfile.update({
      where: { id: profileId },
      data: {
        name,
        identity,
        targetAudience,
        voice,
        tone,
        productsServices,
        expectedUserIntents,
        corePolicies,
        phoneNumbers,
        workingHours,
        address,
        leadCaptureInstructions,
        // Delete existing FAQs and recreate — avoids needing IDs in the payload
        ...(faqs && {
          faqs: {
            deleteMany: {},
            create: faqs.map((faq) => ({
              question: faq.question,
              answer: faq.answer,
            })),
          },
        }),
        ...(knowledgeSections && {
          knowledgeSections: {
            deleteMany: {},
            create: knowledgeSections.map((ks) => ({
              title: ks.title,
              content: ks.content,
            })),
          },
        }),
      },
      include: {
        faqs: true,
        knowledgeSections: true,
        facebookPages: {
          select: {
            pageId: true,
          },
        },
      },
    });

    // trigger partial re-ingestion - only re-embeds what changed
    const updatedFields = Object.keys(
      req.body as BusinessProfileBody,
    ) as (keyof BusinessProfileBody)[];
    await partialReIngestBusinessProfile(profileId, updatedFields);

    const { facebookPages, ...rest } = businessProfile;
    const formattedProfile = {
      ...rest,
      isConnectedToMeta: facebookPages.length > 0,
      socialId: facebookPages.length > 0 ? facebookPages[0].pageId : null,
    };

    return res.status(200).json({
      message: "Business profile updated successfully",
      businessProfile: formattedProfile,
    });
  } catch (error) {
    console.error("Error updating business profile:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const deleteBusinessProfile = async (req: Request, res: Response) => {
  try {
    const userId: number = (req as any).user.id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const profileId = parseInt(req.params.id);

    if (isNaN(profileId)) {
      return res.status(400).json({ message: "Invalid profile id" });
    }

    // Verify the profile exists AND belongs to this user
    const existing = await prisma.businessProfile.findFirst({
      where: { id: profileId, userId },
    });

    if (!existing) {
      return res.status(404).json({ message: "Business profile not found" });
    }

    await prisma.businessProfile.delete({
      where: { id: profileId },
    });

    return res.status(200).json({
      message: "Business profile deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting business profile:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const retrieveBusinessProfile = async (req: Request, res: Response) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ message: "query is required" });

    const chunks = await retrieveRelevantChunks(Number(req.params.id), query);
    res.json({ chunks });
  } catch (err) {
    res.status(500).json({ message: "Retrieval failed", error: err });
  }
};
