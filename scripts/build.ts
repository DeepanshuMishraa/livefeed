const result = await Bun.build({
  entrypoints: ["src/index.tsx"],
  outdir: "dist",
  target: "bun",
  packages: "external",
  minify: true,
  sourcemap: "external",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("Build failed. Source files were left unchanged.");
}
