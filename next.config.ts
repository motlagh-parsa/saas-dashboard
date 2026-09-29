import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // CSV import sends the file text to a Server Action (lib/import-actions.ts),
      // and a file may be up to 5 MB (lib/csv/parse.ts). The default is 1 MB.
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
