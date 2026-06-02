const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

const root = process.cwd();
const appPath = path.join(root, "src/app.ts");
const specPath = path.join(root, "docs/openapi.yaml");

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function stripComments(source) {
  return source
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function joinPaths(prefix, routePath) {
  if (!routePath || routePath === "/") return prefix || "/";
  return `${prefix.replace(/\/$/, "")}/${routePath.replace(/^\//, "")}`.replace(
    /\/+/g,
    "/",
  );
}

function toOpenApiPath(expressPath) {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function resolveImport(specifier) {
  if (specifier.startsWith("@modules/")) {
    return path.join(root, "src/modules", `${specifier.slice("@modules/".length)}.ts`);
  }

  if (specifier.startsWith("@middlewares/")) {
    return path.join(root, "src/middlewares", `${specifier.slice("@middlewares/".length)}.ts`);
  }

  if (specifier.startsWith("@config/")) {
    return path.join(root, "src/config", `${specifier.slice("@config/".length)}.ts`);
  }

  if (specifier.startsWith("@utils/")) {
    return path.join(root, "src/utils", `${specifier.slice("@utils/".length)}.ts`);
  }

  return null;
}

function getDefaultImports(source) {
  const imports = new Map();
  const importPattern = /import\s+(\w+)\s+from\s+["']([^"']+)["']/g;

  for (const match of source.matchAll(importPattern)) {
    imports.set(match[1], match[2]);
  }

  return imports;
}

function getRouterNames(source, mountedVariable) {
  const names = new Set([mountedVariable, "router"]);
  const routerPattern = /const\s+(\w+)\s*=\s*(?:Router|express\.Router)\s*\(/g;

  for (const match of source.matchAll(routerPattern)) {
    names.add(match[1]);
  }

  return names;
}

function parseRouteFile(filePath, prefix, mountedVariable) {
  const source = stripComments(readFile(filePath));
  const routerNames = getRouterNames(source, mountedVariable);
  const routes = [];

  for (const routerName of routerNames) {
    const routePattern = new RegExp(
      `\\b${routerName}\\.(get|post|put|patch|delete)\\(\\s*([\\"'\`])([^\\"'\`]+)\\2`,
      "g",
    );

    for (const match of source.matchAll(routePattern)) {
      routes.push(
        `${match[1].toUpperCase()} ${toOpenApiPath(joinPaths(prefix, match[3]))}`,
      );
    }

    const fileProxyPattern = new RegExp(
      `\\b${routerName}\\.get\\(\\s*/\\\\/file\\\\/\\(\\.\\+\\)/`,
    );
    if (fileProxyPattern.test(source)) {
      routes.push(`GET ${joinPaths(prefix, "/file/{key}")}`);
    }

    const usePattern = new RegExp(
      `\\b${routerName}\\.use\\(\\s*([\\"'\`])([^\\"'\`]+)\\1`,
      "g",
    );

    for (const match of source.matchAll(usePattern)) {
      if (filePath.endsWith("docs.routes.ts") && match[2] === "/docs") {
        routes.push(`GET ${joinPaths(prefix, match[2])}`);
      }

      if (filePath.endsWith("missionControl.routes.ts") && match[2] === "/") {
        routes.push(`GET ${joinPaths(prefix, "/")}`);
        routes.push(`GET ${joinPaths(prefix, "/{path}")}`);
      }
    }
  }

  return routes;
}

function getMountedRouters(appSource, imports) {
  const mounts = [];
  const mountPattern = /app\.use\(\s*["']([^"']+)["']\s*,\s*(\w+)/g;

  for (const match of appSource.matchAll(mountPattern)) {
    const [, prefix, variable] = match;
    const specifier = imports.get(variable);
    if (!specifier) continue;

    const filePath = resolveImport(specifier);
    if (filePath && fs.existsSync(filePath)) {
      mounts.push({ prefix, variable, filePath });
    }
  }

  const widgetPublicSpecifier = imports.get("widgetPublicRoutes");
  const widgetPublicPath =
    widgetPublicSpecifier && resolveImport(widgetPublicSpecifier);
  if (
    widgetPublicPath &&
    fs.existsSync(widgetPublicPath) &&
    !mounts.some((mount) => mount.filePath === widgetPublicPath)
  ) {
    mounts.push({
      prefix: "/v1/public/widget",
      variable: "widgetPublicRoutes",
      filePath: widgetPublicPath,
    });
  }

  return mounts;
}

function getAppLevelRoutes(appSource) {
  const routes = [];
  const appRoutePattern = /app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;

  for (const match of stripComments(appSource).matchAll(appRoutePattern)) {
    routes.push(`${match[1].toUpperCase()} ${toOpenApiPath(match[2])}`);
  }

  return routes;
}

function getExpectedRoutes() {
  const appSource = readFile(appPath);
  const imports = getDefaultImports(appSource);
  const mountedRouters = getMountedRouters(appSource, imports);
  const routes = [];

  for (const mount of mountedRouters) {
    routes.push(...parseRouteFile(mount.filePath, mount.prefix, mount.variable));
  }

  routes.push(...getAppLevelRoutes(appSource));
  return new Set(routes);
}

function getDocumentedRoutes() {
  const spec = YAML.parse(readFile(specPath));
  const routes = [];

  for (const [routePath, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of Object.keys(pathItem || {})) {
      if (HTTP_METHODS.has(method)) {
        routes.push(`${method.toUpperCase()} ${routePath}`);
      }
    }
  }

  return new Set(routes);
}

function sortedDiff(left, right) {
  return [...left].filter((item) => !right.has(item)).sort();
}

function main() {
  const expected = getExpectedRoutes();
  const documented = getDocumentedRoutes();
  const missing = sortedDiff(expected, documented);
  const extra = sortedDiff(documented, expected);

  const result = {
    expected: expected.size,
    documented: documented.size,
    missing,
    extra,
  };

  console.log(JSON.stringify(result, null, 2));

  if (missing.length > 0 || extra.length > 0) {
    console.error(
      "OpenAPI route coverage drift detected. Update docs/openapi.yaml or the route coverage audit.",
    );
    process.exit(1);
  }
}

main();
