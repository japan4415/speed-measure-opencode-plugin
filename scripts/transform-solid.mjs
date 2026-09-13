import { transformFileAsync } from "@babel/core";
import solid from "babel-preset-solid";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outputPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// Match @opentui/solid/scripts/solid-transform.js: compile JSX with Solid's
// universal renderer and do not load repository/user Babel configuration.
const transformed = await transformFileAsync(outputPath, {
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
  await readFile(outputPath, "utf8");
  throw new Error(`Solid transform produced no code for ${outputPath}`);
}

await writeFile(outputPath, `${transformed.code}\n`, "utf8");
