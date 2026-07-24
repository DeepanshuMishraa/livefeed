import type { Bindings } from "../src/bindings";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Bindings {}
}
