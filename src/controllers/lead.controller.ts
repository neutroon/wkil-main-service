import { Request, Response } from "express";
import { createLead, getAllLeads } from "../services/lead.service";

const addLead = async (req: Request, res: Response) => {
  const { name, email, url, message } = req.body;
  const lead = await createLead({ name, email, url, message });
  res.status(201).json(lead);
};

const getLeads = async (req: Request, res: Response) => {
  const leads = await getAllLeads();
  res.status(200).json(leads);
};

export { addLead, getLeads };
