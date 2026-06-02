import { Router } from "express";
import fs from "fs";
import path from "path";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";

const docsRoutes = Router();

let cachedOpenApiDocument: unknown;

function getOpenApiDocument(): unknown {
  if (cachedOpenApiDocument && process.env.NODE_ENV === "production") {
    return cachedOpenApiDocument;
  }

  const readBundledSpec = () => {
    const bundledCandidates = [
      path.resolve(process.cwd(), "dist/openapi.json"),
      path.resolve(__dirname, "../../openapi.json"),
    ];
    const bundledSpecPath = bundledCandidates.find((candidate) =>
      fs.existsSync(candidate),
    );
    if (!bundledSpecPath) return undefined;

    const rawSpec = fs.readFileSync(bundledSpecPath, "utf8");
    return JSON.parse(rawSpec);
  };

  if (process.env.NODE_ENV === "production") {
    const bundledSpec = readBundledSpec();
    if (bundledSpec) {
      cachedOpenApiDocument = bundledSpec;
      return cachedOpenApiDocument;
    }
  }

  const yamlCandidates = [
    path.resolve(process.cwd(), "docs/openapi.yaml"),
    path.resolve(__dirname, "../../../docs/openapi.yaml"),
  ];
  const specPath = yamlCandidates.find((candidate) => fs.existsSync(candidate));

  if (!specPath) {
    const bundledSpec = readBundledSpec();
    if (bundledSpec) {
      cachedOpenApiDocument = bundledSpec;
      return cachedOpenApiDocument;
    }
    throw new Error("OpenAPI spec not found at docs/openapi.yaml");
  }

  const rawSpec = fs.readFileSync(specPath, "utf8");
  cachedOpenApiDocument = YAML.parse(rawSpec);
  return cachedOpenApiDocument;
}

docsRoutes.get("/v1/openapi.json", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(getOpenApiDocument());
});

docsRoutes.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(undefined, {
    explorer: true,
    customSiteTitle: "WKIL API Docs",
    swaggerOptions: {
      url: "/v1/openapi.json",
      persistAuthorization: true,
    },
  }),
);

export default docsRoutes;
