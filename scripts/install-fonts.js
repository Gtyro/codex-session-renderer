#!/usr/bin/env node

import { installBundledFonts } from "../src/lib/font-assets.js";

installBundledFonts().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
