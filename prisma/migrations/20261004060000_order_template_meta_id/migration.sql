-- Expand only: existing configurations remain readable until their next save.
ALTER TABLE "OrderTemplateConfig" ADD COLUMN "metaTemplateId" TEXT;
