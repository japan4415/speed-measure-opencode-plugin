import { transformFileAsync } from "@babel/core";
import solid from "babel-preset-solid";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const inputPath = fileURLToPath(new URL("../.tsup-out/index.js", import.meta.url));
const outputPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const temporaryOutputPath = `${outputPath}.${process.pid}.tmp`;

// Match @opentui/solid/scripts/solid-transform.js: compile JSX with Solid's
// universal renderer and do not load repository/user Babel configuration.
const transformed = await transformFileAsync(inputPath, {
  configFile: false,
  babelrc: false,
  presets: [
    [
      solid,
      {
        moduleName: "@opentui/solid",
        generate: "universal",
      },
    ],
  ],
});

if (transformed?.code === undefined) {
  // Reading here makes the failure message distinguish a missing build output
  // from an unexpected empty Babel result.
  await readFile(inputPath, "utf8");
  throw new Error(`Solid transform produced no code for ${inputPath}`);
}

await mkdir(dirname(outputPath), { recursive: true });
try {
  await writeFile(temporaryOutputPath, `${transformed.code}\n`, "utf8");
  await rename(temporaryOutputPath, outputPath);
} catch (error) {
  await rm(temporaryOutputPath, { force: true });
  throw error;
}
