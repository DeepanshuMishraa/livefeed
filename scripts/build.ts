const result = await Bun.build({
  entrypoints: ["src/index.tsx"],
  outdir: "dist",
  target: "bun",
  packages: "external",
  minify: true,
  sourcemap: "external",
  define: {
    "process.env.LIVEFEED_GOOGLE_CLIENT_ID": JSON.stringify(
      process.env["LIVEFEED_GOOGLE_CLIENT_ID"] ?? "",
    ),
    "process.env.LIVEFEED_GOOGLE_CLIENT_SECRET": JSON.stringify(
      process.env["LIVEFEED_GOOGLE_CLIENT_SECRET"] ?? "",
    ),
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("Build failed. Source files were left unchanged.");
}
