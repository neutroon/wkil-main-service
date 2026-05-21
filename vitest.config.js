"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("vitest/config");
const path_1 = require("path");
exports.default = (0, config_1.defineConfig)({
    resolve: {
        alias: {
            "@modules": (0, path_1.resolve)(__dirname, "src/modules"),
            "@config": (0, path_1.resolve)(__dirname, "src/config"),
            "@middlewares": (0, path_1.resolve)(__dirname, "src/middlewares"),
            "@utils": (0, path_1.resolve)(__dirname, "src/utils"),
            "@scripts": (0, path_1.resolve)(__dirname, "src/scripts"),
        },
    },
    test: {
        globals: false,
        environment: "node",
        include: ["src/**/*.test.ts"],
    },
});
